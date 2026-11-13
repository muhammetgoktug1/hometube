import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROUTES, ERRORS as PROFILE_ERRORS } from "./profileRules.js";
import { createGate } from "./profileGate.js";
import { ERRORS, LIMIT, playlistUrl, normalizePlaylist, browseAnswer, readError } from "./playlist.js";

// The flag is read when the module loads: off here, so starting it must leave no trace.
delete process.env.HOMETUBE_PLAYLISTS;
const { NOTICE, FRESH_MS, readPlaylist, createPlaylists, wirePlaylists, startPlaylists } = await import("./playlists.js");

// Synthetic ids only: videos "vid" + 8 digits, channels "UCsynthetic…", playlists "PLsynthetic…".
const vid = (n) => `vid${String(n).padStart(8, "0")}`;
const chan = (n) => `UCsynthetic${String(n).padStart(13, "0")}`;
const PL = "PLsyntheticPlaylist000000000000001";
const PL2 = "PLsyntheticPlaylist000000000000002";
const FAIL = "PLsyntheticPlaylist00000000000fail";
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// yt-dlp's flat listing, as in lib/playlist.test.js (fewer fields: only the ones read matter here)
const entry = (id, extra = {}) => ({
  id,
  _type: "url",
  ie_key: "Youtube",
  url: `https://www.youtube.com/watch?v=${id}`,
  title: `Synthetic video ${id}`,
  duration: 600,
  channel: "Synthetic One",
  channel_id: chan(1),
  channel_url: `https://www.youtube.com/channel/${chan(1)}`,
  uploader: "Synthetic One",
  uploader_id: "@synthetic-one",
  live_status: null,
  availability: null,
  ...extra,
});
const two = { channel: "Synthetic Two", channel_id: chan(2), channel_url: `https://www.youtube.com/channel/${chan(2)}`, uploader: "Synthetic Two" };
const gone = (id) => entry(id, { title: "[Private video]", duration: null, channel: null, channel_id: null, channel_url: null, uploader: null });
const listing = (id, entries) => ({ id, title: `Synthetic playlist ${id.slice(-1)}`, _type: "playlist", playlist_count: entries.length, channel: "Synthetic One", entries });
const LISTINGS = {
  [PL]: listing(PL, [
    entry(vid(1)),
    entry(vid(2)),
    entry(vid(3), two),
    entry(vid(4), { url: `https://www.youtube.com/shorts/${vid(4)}`, duration: 30 }),
    gone(vid(5)),
    entry(vid(6), { availability: "subscriber_only" }),
    entry(vid(7), { live_status: "is_upcoming" }),
  ]),
  [PL2]: listing(PL2, [entry(vid(1)), entry(vid(8), two)]),
};

// ---- the yt-dlp call itself, with a stand-in for yt-dlp on disk ----
const dir = mkdtempSync(path.join(tmpdir(), "hometube-playlists-"));
const bin = path.join(dir, "yt-dlp");
writeFileSync(path.join(dir, "listing.json"), JSON.stringify(LISTINGS[PL]));
writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "args.log"))}, JSON.stringify(args) + "\\n");
const url = args.at(-1);
if (url.includes("missing")) { process.stderr.write("WARNING: synthetic\\nERROR: [youtube:tab] PLmissing: The playlist does not exist.\\n"); process.exit(1); }
if (url.includes("garbage")) { process.stdout.write("not json"); process.exit(0); }
process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, "listing.json"))}, "utf8"));
`,
);
chmodSync(bin, 0o755);
const fromDisk = await readPlaylist(PL, { bin });
assert.deepEqual(fromDisk, normalizePlaylist(LISTINGS[PL]));
const args = JSON.parse(readFileSync(path.join(dir, "args.log"), "utf8").trim().split("\n")[0]);
// a flat listing of the playlist's own page, one more than the limit, never a pasted link
assert.deepEqual(args.slice(2), ["-J", "--flat-playlist", "-I", `1:${LIMIT + 1}`, "--no-warnings", playlistUrl(PL)]);
assert.equal(args[0], "--js-runtimes");
await assert.rejects(readPlaylist("PLmissing0000000000", { bin }), { message: "The playlist does not exist." });
await assert.rejects(readPlaylist("PLgarbage0000000000", { bin }), SyntaxError);
rmSync(dir, { recursive: true, force: true });

// ---- the two events, with YouTube and the library faked ----
function makeLibrary() {
  const lib = { videos: new Map(), channels: new Map(), avatars: [], opened: [], queueCalls: [], reads: [], paused: false, clock: 1_000_000 };
  let n = 0;
  lib.core = createPlaylists({
    read: async (list) => {
      lib.reads.push(list);
      if (list === FAIL || !LISTINGS[list]) throw new Error("Unable to download API page: HTTP Error 503: Service Unavailable");
      return normalizePlaylist(LISTINGS[list]);
    },
    savedOf: async (ytIds) => new Set(ytIds.filter((id) => lib.videos.has(id))),
    // as lib/playlists.js does: a new channel is created (not followed, avatar queued), a known one kept
    openChannel: async ({ ytId, name, url }) => {
      lib.opened.push(ytId);
      if (!lib.channels.has(ytId)) {
        lib.channels.set(ytId, { _id: `channel-${lib.channels.size + 1}`, ytId, name, url, follow: false, avatar: false });
        lib.avatars.push(ytId);
      }
      return lib.channels.get(ytId);
    },
    // as server.js's: members-only never queued, saved ones skipped
    queueUploads: async (channel, videos, { category, shorts }) => {
      lib.queueCalls.push([channel.ytId, !!shorts, videos.map((v) => v.ytId), category]);
      const ids = [];
      for (const v of videos) {
        if (v.membersOnly || lib.videos.has(v.ytId)) continue;
        const id = (++n).toString(16).padStart(24, "0");
        lib.videos.set(v.ytId, { id, ytId: v.ytId, title: v.title, duration: v.duration, channel: channel._id, category, short: !!shorts, needsProbe: true, status: "queued" });
        ids.push(id);
      }
      return { ids };
    },
    isPaused: () => lib.paused,
    now: () => lib.clock,
    log: { log: () => {} },
  });
  return lib;
}

const lib = makeLibrary();
const { core } = lib;
const read = normalizePlaylist(LISTINGS[PL]);

// reading: each video marked with whether the library has it; the link's own video comes back
lib.videos.set(vid(2), { id: "f".repeat(24), ytId: vid(2) });
let res = await core.browse({ url: `https://youtu.be/${vid(2)}?list=${PL}&si=synthetic` });
assert.deepEqual(res, browseAnswer(read, { video: vid(2), saved: new Set([vid(2)]) }));
assert.deepEqual(res.counts, { listed: 6, saved: 1, unavailable: 2, fresh: 3 });
assert.deepEqual([res.total, res.hidden, res.truncated, res.playlist.id], [7, 1, false, PL]);
assert.deepEqual(lib.reads, [PL]);
// the same playlist again: the reading is used again, the marks are not
lib.videos.set(vid(1), { id: "e".repeat(24), ytId: vid(1) });
res = await core.browse({ url: PL });
assert.deepEqual(res.videos.filter((v) => v.saved).map((v) => v.ytId), [vid(1), vid(2)]);
assert.deepEqual(lib.reads, [PL]);
// … until it's old
lib.clock += FRESH_MS;
await core.browse({ url: playlistUrl(PL) });
assert.deepEqual(lib.reads, [PL, PL]);
lib.videos.delete(vid(1));
lib.videos.delete(vid(2));

// what isn't a playlist never reaches YouTube
const before = lib.reads.length;
assert.deepEqual(await core.browse({ url: `https://www.youtube.com/watch?v=${vid(1)}&list=RD${vid(1)}` }), { error: ERRORS.mix, video: vid(1) });
assert.deepEqual(await core.browse({ url: "https://www.youtube.com/playlist?list=WL" }), { error: ERRORS.private });
assert.deepEqual(await core.browse({ url: "https://www.youtube.com/@synthetic/playlists" }), { error: ERRORS.playlists });
assert.deepEqual(await core.browse({ url: `https://www.youtube.com/watch?v=${vid(1)}` }), { error: ERRORS.link, video: vid(1) });
assert.deepEqual(await core.browse({}), { error: ERRORS.link });
assert.deepEqual(await core.download({ list: "RDsynthetic0000000000000001", videos: [vid(1)] }), { error: ERRORS.mix });
assert.equal(lib.reads.length, before);
// a reading that fails says why and is tried again next time
assert.deepEqual(await core.browse({ url: FAIL }), { error: readError("Unable to download API page: HTTP Error 503: Service Unavailable") });
await core.browse({ url: FAIL });
assert.equal(lib.reads.filter((l) => l === FAIL).length, 2);
// while YouTube's bot check has the downloads paused, neither event asks it anything
lib.paused = true;
assert.deepEqual(await core.browse({ url: PL2 }), { error: ERRORS.paused });
assert.deepEqual(await core.download({ list: PL2, videos: [vid(8)] }), { error: ERRORS.paused });
assert.equal(lib.reads.includes(PL2), false);
lib.paused = false;

// downloading: the picked ids are looked up in the library's own reading; titles and channels never
// come from the client; one queue call per channel and kind; a new channel isn't followed
lib.videos.set(vid(2), { id: "f".repeat(24), ytId: vid(2) });
const spoof = { ytId: vid(3), title: "Spoofed title", duration: 1, channel: { ytId: chan(9), name: "Spoofed" }, membersOnly: false };
res = await core.download({ list: PL, videos: [vid(1), vid(2), spoof, vid(4), vid(5), vid(6), vid(7), vid(404), "bad"], category: "c".repeat(24) });
assert.deepEqual([res.queued, res.linked, res.saved, res.unavailable, res.ids.length], [3, 0, 1, 4, 3]);
assert.equal(res.picked, undefined);
assert.deepEqual(lib.queueCalls, [
  [chan(1), false, [vid(1)], "c".repeat(24)],
  [chan(2), false, [vid(3)], "c".repeat(24)],
  [chan(1), true, [vid(4)], "c".repeat(24)],
]);
assert.deepEqual([lib.videos.get(vid(3)).title, lib.videos.get(vid(3)).duration, lib.videos.get(vid(3)).channel], [`Synthetic video ${vid(3)}`, 600, "channel-2"]);
assert.deepEqual([...lib.channels.values()].map((c) => [c.ytId, c.follow, c.url]), [
  [chan(1), false, `https://www.youtube.com/channel/${chan(1)}`],
  [chan(2), false, `https://www.youtube.com/channel/${chan(2)}`],
]);
assert.deepEqual(lib.avatars, [chan(1), chan(2)]);
// the channel with a video and a Short is opened once
assert.deepEqual(lib.opened, [chan(1), chan(2)]);
assert.equal(lib.videos.get(vid(4)).short, true);
// the second time: all saved, nothing queued, no new channel
lib.queueCalls = [];
res = await core.download({ list: `https://www.youtube.com/watch?v=${vid(1)}&list=${PL}`, videos: [vid(1), vid(2), vid(3), vid(4)] });
assert.deepEqual(res, { ids: [], queued: 0, linked: 0, saved: 4, unavailable: 0 });
assert.deepEqual(lib.queueCalls, []);
// nothing picked: nothing read
const reads = lib.reads.length;
assert.deepEqual(await core.download({ list: PL2, videos: [] }), { ids: [], queued: 0, linked: 0, saved: 0, unavailable: 0 });
assert.equal(lib.reads.length, reads);
// two clicks at once queue the videos once
const [first, second] = await Promise.all([core.download({ list: PL2, videos: [vid(8)] }), core.download({ list: PL2, videos: [vid(8)] })]);
assert.deepEqual([first.queued, second.queued, second.saved], [1, 0, 1]);

// with a scope (profiles on): saved means the scope's; the library's own videos are picked but
// not created again, and the picked ids come back for the profile to link (linked: how many of them)
res = await core.browse({ url: PL }, { saved: new Set([vid(3)]) });
assert.deepEqual(res, browseAnswer(read, { video: "", saved: new Set([vid(3)]) }));
const count = lib.videos.size;
res = await core.download({ list: PL, videos: [vid(1), vid(3), vid(5)] }, { saved: new Set([vid(3)]) });
assert.deepEqual(res, { ids: [], queued: 0, linked: 1, saved: 1, unavailable: 1, picked: [vid(1)] });
assert.equal(lib.videos.size, count);
// a scope that isn't one (what a client could send) counts for nothing
res = await core.browse({ url: PL }, { saved: [vid(5)] });
assert.deepEqual(res.videos.filter((v) => v.saved).map((v) => v.ytId), [vid(1), vid(2), vid(3), vid(4)]);

// ---- the notice and the wiring ----
const fakeIo = () => {
  const io = { listeners: [], on: (name, fn) => name === "connection" && io.listeners.push(fn) };
  return io;
};
const fakeSocket = (profile) => ({ data: { profile }, got: [], handlers: {}, emit(name, payload) { this.got.push([name, payload]); }, on(name, fn) { this.handlers[name] = fn; } });
// off: nothing is listened to, nothing is said
const offIo = fakeIo();
assert.equal(startPlaylists(offIo, {}), undefined);
assert.deepEqual(offIo.listeners, []);
// on: every connection hears it, except one that still has to pick a profile
const io = fakeIo();
const wired = { enqueued: [], changed: 0 };
wirePlaylists(io, Promise.resolve(makeLibrary().core), { enqueue: (id) => wired.enqueued.push(id), changed: async () => (wired.changed += 1) });
const sockets = [undefined, null, { id: "a".repeat(24) }].map((p) => {
  const s = fakeSocket(p);
  io.listeners.forEach((fn) => fn(s));
  return s;
});
assert.equal(NOTICE, "playlists:on");
assert.deepEqual(sockets.map((s) => s.got.map(([name]) => name)), [[NOTICE], [], [NOTICE]]);
assert.deepEqual(Object.keys(sockets[0].handlers).sort(), ["playlist:browse", "playlist:download"]);
const ask = (s, name, ...a) => new Promise((resolve) => s.handlers[name](...a, resolve));
assert.equal((await ask(sockets[0], "playlist:browse", { url: PL })).counts.listed, 6);
// the created videos are queued once the library has been sent out; a download that queues nothing sends nothing
res = await ask(sockets[0], "playlist:download", { list: PL, videos: [vid(1), vid(3)] });
await settle();
assert.deepEqual([wired.changed, wired.enqueued], [1, res.ids]);
await ask(sockets[0], "playlist:download", { list: PL, videos: [vid(1)] });
await settle();
assert.deepEqual([wired.changed, wired.enqueued.length], [1, 2]);
// asked without wanting an answer: ignored
sockets[0].handlers["playlist:download"]({ list: PL, videos: [vid(2)] });
await settle();
assert.equal(wired.enqueued.length, 2);

// ---- with profiles on: the gate in front (lib/profileGate.js) ----
assert.deepEqual([ROUTES["playlist:browse"], ROUTES["playlist:download"]], ["wrap", "take"]);
const g = makeLibrary();
const mem = { profiles: [], links: [], cats: [] };
const idOf = (ytId) => g.videos.get(ytId)?.id;
const store = {
  profiles: async () => mem.profiles,
  profileById: async (id) => mem.profiles.find((p) => p.id === id) || null,
  profileByKey: async () => null,
  videoCounts: async () => new Map(),
  orphanCount: async () => 0,
  links: async (profile) => mem.links.filter((l) => l.profile === profile).map((l) => ({ ...l, watchedAt: 0, position: 0, addedAt: 1 })),
  categories: async (profile) => mem.cats.filter((c) => c.profile === profile).map(({ id, name }) => ({ id, name })),
  follows: async () => [],
  hasCategory: async (profile, id) => mem.cats.some((c) => c.profile === profile && c.id === id),
  memberVideos: async (profile) => [...g.videos.values()].filter((v) => mem.links.some((l) => l.profile === profile && l.video === v.id)).map((v) => ({ id: v.id, ytId: v.ytId, channel: v.channel, size: 0 })),
  videosByYtIds: async (ytIds) => ytIds.filter((y) => g.videos.has(y)).map((y) => ({ id: idOf(y), ytId: y })),
  link: async (profile, videos, { category } = {}) => {
    const fresh = [...new Set(videos)].filter((video) => !mem.links.some((l) => l.profile === profile && l.video === video));
    fresh.forEach((video) => mem.links.push({ profile, video, category: category || "" }));
    return fresh;
  },
};
const rooms = new Map();
const all = new Map();
const gateIo = { sockets: { sockets: all, adapter: { rooms } }, to: (room) => ({ emit: (name, payload) => (rooms.get(room) || new Set()).forEach((id) => all.get(id).got.push([name, payload])) }) };
const library = async () => ({ videos: [...g.videos.values()].map((v) => ({ ...v, savedAt: 1 })), channels: [], categories: [] });
const gate = createGate({ store, io: gateIo, upstream: { library }, log: { warn: () => {}, error: (...m) => assert.fail(m.join(" ")) } });
const queued = [];
const playlistIo = fakeIo();
let on = true;
wirePlaylists(playlistIo, g.core, { enqueue: (id) => queued.push(id), changed: async () => {} });
let sid = 0;
async function connect(profile) {
  const socket = {
    id: `s${++sid}`,
    data: {},
    handshake: { auth: profile ? { profile } : {} },
    got: [],
    handlers: {},
    join(room) {
      (rooms.get(room) || rooms.set(room, new Set()).get(room)).add(this.id);
    },
    leave() {},
    emit(name, payload) {
      this.got.push([name, payload]);
    },
    on(name, fn) {
      this.handlers[name] = fn;
    },
    use(fn) {
      this.middleware = fn;
    },
  };
  await gate.handshake(socket);
  all.set(socket.id, socket);
  // as in server.js: the profiles' connection listener first, then the playlists'
  gate.connect(socket);
  if (on) playlistIo.listeners.forEach((fn) => fn(socket));
  return socket;
}
// Sends an event through the gate: { res, passed } (passed: the playlists' handler ran).
async function send(socket, name, ...a) {
  let passed = false;
  const answered = new Promise((resolve) => {
    const packet = [name, ...a, resolve];
    socket.middleware(packet, () => {
      passed = true;
      socket.handlers[name]?.(...packet.slice(1));
    });
  });
  const got = await Promise.race([answered, settle().then(settle).then(settle).then(() => "no answer")]);
  await settle();
  return { res: got, passed };
}
const A = { id: "a".repeat(24), name: "Alice", color: 200 };
const B = { id: "b".repeat(24), name: "Bob", color: 32 };
mem.profiles.push(A, B);
mem.cats.push({ id: "1".repeat(24), profile: A.id, name: "Shows" }, { id: "2".repeat(24), profile: B.id, name: "Cartoons" });
const alice = await connect(A.id);
const bob = await connect(B.id);
const nobody = await connect();
// told the feature is on once a profile is picked
assert.deepEqual([alice, bob, nobody].map((s) => s.got.some(([name]) => name === NOTICE)), [true, true, false]);
// without a profile: refused before anything runs
for (const name of ["playlist:browse", "playlist:download"]) assert.deepEqual(await send(nobody, name, { url: PL, list: PL, videos: [vid(1)] }), { res: { error: PROFILE_ERRORS.pick }, passed: false });

// Alice saves a video of the playlist before the import exists, then imports two more
const v0 = (await g.core.download({ list: PL, videos: [vid(1)] })).ids[0];
await store.link(A.id, [v0]);
queued.length = 0;
let r = await send(alice, "playlist:download", { list: PL, videos: [vid(2), vid(3)], category: "1".repeat(24) });
assert.deepEqual([r.passed, r.res.queued, r.res.linked, r.res.saved, r.res.unavailable, r.res.ids.length], [true, 2, 0, 0, 0, 2]);
assert.deepEqual(queued.sort(), [idOf(vid(2)), idOf(vid(3))].sort());
// the profile's category is kept on its link, never on the video
assert.equal(g.videos.get(vid(2)).category, undefined);
assert.deepEqual(mem.links.filter((l) => l.profile === A.id).map((l) => l.category), ["", "1".repeat(24), "1".repeat(24)]);
const alicesLinks = JSON.stringify(mem.links.filter((l) => l.profile === A.id));
const nothingSaved = browseAnswer(read, { video: "", saved: new Set() });
// Alice sees her three saved; Bob, who has nothing, gets exactly the answer of an empty library
r = await send(alice, "playlist:browse", { url: PL });
assert.deepEqual(r.res.videos.filter((v) => v.saved).map((v) => v.ytId), [vid(1), vid(2), vid(3)]);
assert.deepEqual(r.res.counts, { listed: 6, saved: 3, unavailable: 2, fresh: 1 });
r = await send(bob, "playlist:browse", { url: PL });
assert.deepEqual(r.res, nothingSaved);
// a scope Bob sends along is replaced by his own
r = await send(bob, "playlist:browse", { url: PL }, { saved: new Set([vid(1), vid(2), vid(3)]) });
assert.deepEqual(r.res, nothingSaved);
// Bob downloads: what the library has (Alice's) is linked, not downloaded again; only the new one is created
const videosBefore = g.videos.size;
queued.length = 0;
r = await send(bob, "playlist:download", { list: PL, videos: [vid(1), vid(2), vid(4), vid(5), vid(404)], category: "2".repeat(24) });
assert.deepEqual([r.res.queued, r.res.linked, r.res.saved, r.res.unavailable, Object.keys(r.res)], [3, 2, 0, 2, ["ids", "queued", "linked", "saved", "unavailable"]]);
assert.deepEqual(r.res.ids.sort(), [idOf(vid(1)), idOf(vid(2)), idOf(vid(4))].sort());
assert.deepEqual([g.videos.size - videosBefore, queued], [1, [idOf(vid(4))]]);
// queued less linked: the ones that went into the download queue
assert.equal(r.res.queued - r.res.linked, queued.length);
assert.ok(mem.links.filter((l) => l.profile === B.id).every((l) => l.category === "2".repeat(24)));
// the other counts are the ones an empty library would give Bob: of Alice's, only how many weren't downloaded again
const empty = makeLibrary();
const alone = await empty.core.download({ list: PL, videos: [vid(1), vid(2), vid(4), vid(5), vid(404)] });
assert.deepEqual([r.res.queued, r.res.saved, r.res.unavailable], [alone.queued, alone.saved, alone.unavailable]);
assert.equal(alone.linked, 0);
// Alice's library is as it was
assert.equal(JSON.stringify(mem.links.filter((l) => l.profile === A.id)), alicesLinks);
// again: all of it saved for Bob, nothing created or linked
r = await send(bob, "playlist:download", { list: PL, videos: [vid(1), vid(2), vid(4)] });
assert.deepEqual(r.res, { ids: [], queued: 0, linked: 0, saved: 3, unavailable: 0 });
assert.equal(g.videos.size, videosBefore + 1);
// another profile's category isn't taken
r = await send(bob, "playlist:download", { list: PL, videos: [vid(3)], category: "1".repeat(24) });
assert.deepEqual([r.res.queued, mem.links.find((l) => l.profile === B.id && l.video === idOf(vid(3))).category], [1, ""]);
// what Bob reads now: his own four
r = await send(bob, "playlist:browse", { url: PL });
assert.deepEqual(r.res.videos.filter((v) => v.saved).map((v) => v.ytId), [vid(1), vid(2), vid(3), vid(4)]);
// a reading error passes as it is
assert.deepEqual((await send(bob, "playlist:browse", { url: "https://www.youtube.com/watch?v=" + vid(1) + "&list=RDMM" })).res, { error: ERRORS.mix, video: vid(1) });

// two profiles pick the same playlist: the first one's new video is downloaded, the second one's answer
// says nothing went into the queue and the video was only linked
queued.length = 0;
r = await send(alice, "playlist:download", { list: PL2, videos: [vid(1), vid(8)] });
assert.deepEqual([r.res.queued, r.res.linked, r.res.saved, r.res.unavailable, queued], [1, 0, 1, 0, [idOf(vid(8))]]);
const videosThen = g.videos.size;
queued.length = 0;
r = await send(bob, "playlist:download", { list: PL2, videos: [vid(1), vid(8)] });
assert.deepEqual(r.res, { ids: [idOf(vid(8))], queued: 1, linked: 1, saved: 1, unavailable: 0 });
assert.deepEqual([r.res.queued - r.res.linked, queued, g.videos.size], [0, [], videosThen]);
// a profile that has none of them: both linked from the library, none downloaded
const C = { id: "c".repeat(24), name: "Carol", color: 120 };
mem.profiles.push(C);
const carol = await connect(C.id);
r = await send(carol, "playlist:download", { list: PL2, videos: [vid(1), vid(8)] });
assert.deepEqual([r.res.queued, r.res.linked, r.res.saved, queued, g.videos.size], [2, 2, 0, [], videosThen]);

// with the feature off the gate still routes the events, but nobody answers and nothing is written
on = false;
const offBob = await connect(B.id);
assert.equal(offBob.got.some(([name]) => name === NOTICE), false);
const linksBefore = mem.links.length;
const sizeBefore = g.videos.size;
assert.deepEqual(await send(offBob, "playlist:download", { list: PL2, videos: [vid(8)] }), { res: "no answer", passed: true });
assert.deepEqual(await send(offBob, "playlist:browse", { url: PL2 }), { res: "no answer", passed: true });
assert.deepEqual([mem.links.length, g.videos.size], [linksBefore, sizeBefore]);

console.log("playlists ok");
