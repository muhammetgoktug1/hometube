import { execFile } from "node:child_process";
import { ERRORS, LIMIT, playlistLink, playlistUrl, normalizePlaylist, readFailure, browseAnswer, pickedIds, planDownload, byChannel } from "./playlist.js";

// Adds the videos of a YouTube playlist: playlist:browse reads it (each video marked saved or not),
// playlist:download queues the picked ones through the library's own queue, a channel at a time.
// Off unless HOMETUBE_PLAYLISTS=1, and then nothing here runs: no event, no notice, no log line.
// It keeps no collection of its own; a reading is remembered in memory for a while.
const ON = /^(1|true|yes)$/i.test(process.env.HOMETUBE_PLAYLISTS || "");

// Clients offer playlists only after hearing this: sent to every new connection (with profiles on,
// once it has picked one), never while the feature is off, so then nothing asks.
export const NOTICE = "playlists:on";

// how long a reading is used again (a download picked from it needs no second visit), and how many are kept
export const FRESH_MS = 15 * 60_000;
const KEPT = 20;
// a playlist of 1000 videos takes a few seconds; one that takes this long isn't coming
const READ_TIMEOUT_MS = 120_000;

// as in lib/youtube.js: yt-dlp looks for deno by default; point it at the Node running this server
const JS_RUNTIME = ["--js-runtimes", `node:${process.execPath}`];

// yt-dlp's last stderr line, without its "ERROR: [youtube:tab] id:" prefix.
const reasonOf = (stderr) =>
  (String(stderr || "").trim().split("\n").at(-1) || "").replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "");

// The playlist as YouTube lists it now, without per-video details (normalizePlaylist). One more
// than limit is asked for, so a longer playlist is known to be cut short. bin: for tests.
export function readPlaylist(list, { limit = LIMIT, bin = "yt-dlp" } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...JS_RUNTIME, "-J", "--flat-playlist", "-I", `1:${limit + 1}`, "--no-warnings", playlistUrl(list)];
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: READ_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(reasonOf(stderr) || err.message));
      try {
        resolve(normalizePlaylist(JSON.parse(stdout), limit));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const failure = ({ error, video }) => ({ error: ERRORS[error], ...(video ? { video } : {}) });

// The two events, with YouTube and the library passed in so they can be tested without either.
// read(list): a reading (readPlaylist); savedOf(ytIds): the ones the library has, as a Set;
// openChannel({ ytId, name, url }): the library's channel, created when it's new (never followed);
// queueUploads(channel, videos, { category, shorts }) → { ids }: server.js's; isPaused(): YouTube's bot check.
// Both take scope.saved: the YouTube ids that count as saved (with profiles on, the profile's; see
// lib/profileGate.js); without it the whole library's.
export function createPlaylists({ read, savedOf, openChannel, queueUploads, isPaused, now = Date.now, log = console }) {
  const readings = new Map();

  function reading(list) {
    const kept = readings.get(list);
    if (kept && now() - kept.at < FRESH_MS) return kept.promise;
    const startedAt = now();
    const promise = read(list).then((r) => {
      log.log(`playlist read: ${r.videos.length} of ${r.total} videos in ${((now() - startedAt) / 1000).toFixed(1)} s`);
      return r;
    });
    readings.delete(list);
    readings.set(list, { at: startedAt, promise });
    // a failed reading is tried again next time
    promise.catch(() => readings.get(list)?.promise === promise && readings.delete(list));
    while (readings.size > KEPT) readings.delete(readings.keys().next().value);
    return promise;
  }

  // playlist:browse { url } → browseAnswer, or { error }
  async function browse(data, scope) {
    if (isPaused()) return { error: ERRORS.paused };
    const link = playlistLink(data?.url ?? data?.list);
    if (link.error) return failure(link);
    let read;
    try {
      read = await reading(link.list);
    } catch (err) {
      return { error: readFailure(err.message) };
    }
    const saved = scope?.saved instanceof Set ? scope.saved : await savedOf(read.videos.map((v) => v.ytId));
    return browseAnswer(read, { video: link.video, saved });
  }

  // playlist:download { list, videos, category } → { ids, queued, saved, unavailable }, or { error }.
  // ids: the videos created (the caller queues them). With scope, also picked: the YouTube ids of the
  // listed videos to add, so the profile links the ones the library has already.
  async function download(data, scope) {
    if (isPaused()) return { error: ERRORS.paused };
    const link = playlistLink(data?.list ?? data?.url);
    if (link.error) return failure(link);
    const ids = pickedIds(data?.videos);
    const scoped = scope?.saved instanceof Set;
    if (!ids.length) return { ids: [], queued: 0, saved: 0, unavailable: 0, ...(scoped ? { picked: [] } : {}) };
    let read;
    try {
      read = await reading(link.list);
    } catch (err) {
      return { error: readFailure(err.message) };
    }
    const library = await savedOf(ids);
    const plan = planDownload(read, ids, scoped ? scope.saved : library);
    // the library downloads a video once, whoever asked for it first
    const groups = byChannel(plan.picked.filter((v) => !library.has(v.ytId)));
    const created = [];
    // a channel with both videos and Shorts here is opened (and its avatar asked for) once
    const channels = new Map();
    for (const group of groups) {
      if (!channels.has(group.channel.ytId)) channels.set(group.channel.ytId, await openChannel(group.channel));
      const res = await queueUploads(channels.get(group.channel.ytId), group.videos, { category: data.category, shorts: group.short });
      created.push(...res.ids);
    }
    if (created.length) log.log(`playlist: ${created.length} videos queued from ${channels.size} channels`);
    const res = { ids: created, queued: created.length, saved: plan.saved.length, unavailable: plan.unavailable.length };
    return scoped ? { ...res, picked: plan.picked.map((v) => v.ytId) } : res;
  }

  // one download at a time, so a second click can't queue the same videos twice
  let turn = Promise.resolve();
  const inTurn = (data, scope) => {
    const run = turn.then(() => download(data, scope));
    turn = run.catch(() => {});
    return run;
  };

  return { browse, download: inTurn, readings };
}

// With profiles on (lib/profileGate.js), a connection that hasn't picked one yet hears it once it
// has: picking one connects again.
const tell = (socket) => socket.data.profile !== null && socket.emit(NOTICE);

// The two events and the notice on every connection. core: createPlaylists' (or a promise of it);
// enqueue(id) and changed() as server.js has them: the library is sent out once videos are created.
export function wirePlaylists(io, core, { enqueue, changed }) {
  const run = async (name, data, scope) => {
    try {
      return await (await core)[name](data || {}, scope);
    } catch (err) {
      return { error: err.message };
    }
  };
  io.on("connection", (socket) => {
    // with profiles on the gate passes the profile's videos as (data, { saved }, ack)
    socket.on("playlist:browse", async (...args) => {
      const ack = args.pop();
      if (typeof ack !== "function") return;
      ack(await run("browse", ...args));
    });
    socket.on("playlist:download", async (...args) => {
      const ack = args.pop();
      if (typeof ack !== "function") return;
      const res = await run("download", ...args);
      ack(res);
      if (res.error || !res.ids?.length) return;
      await changed();
      res.ids.forEach(enqueue);
    });
    tell(socket);
  });
}

// io: the socket.io server; deps from server.js: { queueUploads, enqueue, changed, avatarQueue }.
export function startPlaylists(io, { queueUploads, enqueue, changed, avatarQueue }) {
  if (!ON) return;
  // loaded only when it's on (and so the rules above can be tested without a database)
  const core = Promise.all([import("./models.js"), import("./queue.js")]).then(([{ Video, Channel }, { isPaused }]) =>
    createPlaylists({
      read: (list) => readPlaylist(list),
      savedOf: async (ytIds) => new Set((await Video.find({ ytId: { $in: ytIds } }, { ytId: 1 }).lean()).map((v) => v.ytId)),
      // a new channel, as for a pasted channel's Shorts link; one the library has stays as it is
      openChannel: async ({ ytId, name, url }) => {
        const channel =
          (await Channel.findOne({ ytId }).lean()) ||
          (await Channel.findOneAndUpdate({ ytId }, { $setOnInsert: { name: name || "Unknown channel", url } }, { upsert: true, returnDocument: "after" }).lean());
        if (!channel.avatar) avatarQueue.push(channel);
        return channel;
      },
      queueUploads,
      isPaused,
    }),
  );
  core.catch((err) => console.error("playlists failed", err.message));
  wirePlaylists(io, core, { enqueue, changed });
  console.log(`playlists on: up to ${LIMIT} videos a playlist`);
}
