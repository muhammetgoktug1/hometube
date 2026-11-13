import { channelShortsOf, videoIdOf } from "./youtube.js";
import {
  ROUTES,
  OPEN,
  ERRORS,
  KIDS_ERRORS,
  COLORS,
  kidMay,
  takesLastGrownUp,
  noProfile,
  lockedSettings,
  isId,
  profileName,
  nameKey,
  pickColor,
  categoryName,
  ytIdsOf,
  libraryFor,
  storageFor,
  markSaved,
  dupesFor,
  claimPlan,
} from "./profileRules.js";

// what the library answers when every Short of a pasted channel link is saved already (server.js)
const ALL_SHORTS_SAVED = "All of this channel's Shorts are already in your library.";

export const roomOf = (id) => `profile:${id}`;

const once = (fn) => {
  let done = false;
  return (res) => {
    if (done || !fn) return;
    done = true;
    fn(res);
  };
};

// A packet's data sits before its ack, which may be missing.
const setData = (packet, data) => (typeof packet[1] === "function" || packet.length < 2 ? packet.splice(1, 0, data) : (packet[1] = data));

// A profile from the list (listing() adds how many videos it has) as a connection keeps it.
const withoutCount = ({ videos, ...profile }) => profile;

// The one way in while profiles are on; lib/profiles.js wires it into socket.io.
// store: the profile collections (lib/profiles.js); io: the socket.io server;
// upstream: { library(), removeVideo(id), followChannel(id, follow) } from the library;
// kids: HOMETUBE_KIDS is on, so a kids profile is refused what KIDS says and profile:update takes kid.
export function createGate({ store, io, upstream, log = console, kids = false }) {
  const socketsIn = (room) => [...(io.sockets.adapter.rooms.get(room) || [])].map((id) => io.sockets.sockets.get(id)).filter(Boolean);

  async function viewOf(profile, lib) {
    const [links, categories, follows] = await Promise.all([store.links(profile.id), store.categories(profile.id), store.follows(profile.id)]);
    return libraryFor(lib, { profile, links, categories, follows });
  }

  // Each profile someone is watching as gets its own library; a connection without one gets none.
  async function broadcast() {
    try {
      const rooms = [...io.sockets.adapter.rooms.keys()].filter((room) => room.startsWith("profile:"));
      if (!rooms.length) return;
      const lib = await upstream.library();
      await Promise.all(
        rooms.map(async (room) => {
          const profile = socketsIn(room)[0]?.data.profile;
          if (profile) io.to(room).emit("library", await viewOf(profile, lib));
        }),
      );
    } catch (err) {
      log.error("broadcast failed", err.message);
    }
  }

  async function listing() {
    const [profiles, counts, orphans] = await Promise.all([store.profiles(), store.videoCounts(), store.orphanCount()]);
    return { profiles: profiles.map((p) => ({ ...p, videos: counts.get(p.id) || 0 })), orphans };
  }

  const stateOf = (socket, { profiles, orphans }) => ({
    current: socket.data.profile || null,
    list: profiles,
    orphans,
    ...(socket.data.removed ? { reason: "removed" } : {}),
  });

  // Before a connection is accepted: the profile it asked for with auth.profile, an id or else a name.
  async function handshake(socket) {
    const wanted = socket.handshake.auth?.profile;
    try {
      let profile = null;
      if (typeof wanted === "string" && wanted) profile = (isId(wanted) && (await store.profileById(wanted))) || (await store.profileByKey(nameKey(wanted)));
      socket.data.profile = profile || null;
      socket.data.removed = !!wanted && !profile;
      socket.data.state = stateOf(socket, await listing());
    } catch (err) {
      log.error("profile handshake failed", err.message);
      socket.data.profile = null;
      socket.data.state = { current: null, list: [], orphans: 0 };
    }
  }

  // A new connection: told who it is (before it asks for the library) and routed through the gate.
  function connect(socket) {
    const { profile, state } = socket.data;
    if (profile) socket.join(roomOf(profile.id));
    socket.emit("profiles", state);
    delete socket.data.state;
    socket.data.removed = false;
    socket.use((packet, next) => route(socket, packet, next));
  }

  // Every connection gets the new list; those whose profile is gone go back to picking one.
  async function announce() {
    try {
      const list = await listing();
      const byId = new Map(list.profiles.map((p) => [p.id, p]));
      for (const socket of io.sockets.sockets.values()) {
        const current = socket.data.profile;
        const now = current && byId.get(current.id);
        if (current && !now) {
          socket.leave(roomOf(current.id));
          socket.data.removed = true;
        }
        socket.data.profile = now ? withoutCount(now) : null;
        socket.emit("profiles", stateOf(socket, list));
        socket.data.removed = false;
      }
    } catch (err) {
      log.error("profile list failed", err.message);
    }
  }

  // Lets the library's own handler run and changes its answer with fix(res) on the way to the
  // client; after(answer) runs once the client has it. An answer is always asked for, so the fix
  // happens even when the client didn't want one.
  function relay({ packet, next, reply }, fix, after = () => {}) {
    const answer = (res) =>
      Promise.resolve(res)
        .then(fix)
        .catch((err) => {
          log.error(`${packet[0]} failed`, err.message);
          return { error: err.message };
        })
        .then((fixed) => {
          reply(fixed);
          return after(fixed);
        });
    if (typeof packet.at(-1) === "function") packet[packet.length - 1] = answer;
    else packet.push(answer);
    next();
  }

  const ownCategory = async (profile, id) => (isId(id) && (await store.hasCategory(profile.id, id)) ? id : undefined);
  const mine = async (profile) => store.memberVideos(profile.id);
  const linked = (res) => res && !res.error && broadcast();

  // Takes a video out of a profile; the last profile to let go of it deletes it with its files.
  async function drop(profile, video) {
    await store.unlink(profile.id, video);
    if (!(await store.linkCount(video))) await upstream.removeVideo(video);
  }

  // Whether a Short of the channel the library just read (touched since `since`) is saved but not in the profile.
  async function shortsElsewhere(profile, since) {
    const channels = await store.channelsSince(since);
    if (!channels.length) return false;
    const have = new Set((await mine(profile)).map((v) => v.id));
    return (await store.shortsOf(channels)).some((id) => !have.has(id));
  }

  async function addVideo({ profile, packet, args, reply, next }) {
    const data = args[0] && typeof args[0] === "object" ? args[0] : {};
    const category = await ownCategory(profile, data.category);
    const linkNew = async (res) => {
      const ids = res?.ids || (res?.id ? [res.id] : []);
      if (ids.length) await store.link(profile.id, ids, { category });
      return res;
    };
    // the profile's category is kept on its link, never on the video
    setData(packet, { ...data, category: undefined });
    if (channelShortsOf(data.url)) {
      // a channel's Shorts link: the library queues the ones nobody has; ones another profile has stay there
      const since = new Date();
      return relay(
        { packet, next, reply },
        async (res) => (res?.error === ALL_SHORTS_SAVED && (await shortsElsewhere(profile, since)) ? { error: ERRORS.shorts } : linkNew(res)),
        linked,
      );
    }
    const ytId = videoIdOf(data.url);
    const saved = ytId && (await store.videoByYtId(ytId));
    if (saved && !(await store.isMember(profile.id, saved.id))) {
      // saved already (by another profile, or by none): linked, nothing is downloaded again
      await store.link(profile.id, [saved.id], { category });
      reply({ id: saved.id });
      return broadcast();
    }
    // a new video, a link that isn't one, or one the profile has: the library answers as always
    relay({ packet, next, reply }, linkNew, linked);
  }

  // Get videos on a channel page: picked uploads saved already are linked, the library queues the rest.
  async function download({ profile, packet, args, reply, next }) {
    const data = args[0] && typeof args[0] === "object" ? args[0] : {};
    const category = await ownCategory(profile, data.category);
    const saved = isId(data.channel) && (await store.channel(data.channel)) ? await store.videosByYtIds(ytIdsOf(data.videos)) : [];
    const added = await store.link(profile.id, saved.map((v) => v.id), { category });
    setData(packet, { ...data, category: undefined });
    relay(
      { packet, next, reply },
      async (res) => {
        if (res?.error) return added.length ? { ids: added } : res;
        await store.link(profile.id, res.ids, { category });
        // a new object: the library goes on to queue only the ones it created
        return { ...res, ids: [...res.ids, ...added] };
      },
      linked,
    );
  }

  // Playlists (lib/playlists.js): the library is told which videos count as saved (the profile's),
  // so its marks and counts never show what another profile has. Picked videos the library has
  // already are linked, not downloaded again; the rest are created once and linked.
  function withSaved(c, data, saved) {
    const ack = typeof c.packet.at(-1) === "function" ? [c.packet.at(-1)] : [];
    c.packet.splice(1, c.packet.length - 1, data, { saved }, ...ack);
  }
  const savedYtIds = async (profile) => new Set((await mine(profile)).map((v) => v.ytId));

  async function playlistBrowse(c) {
    withSaved(c, c.args[0] ?? null, await savedYtIds(c.profile));
    relay(c, (res) => res);
  }

  async function playlistDownload(c) {
    const data = c.args[0] && typeof c.args[0] === "object" ? c.args[0] : {};
    const category = await ownCategory(c.profile, data.category);
    withSaved(c, { ...data, category: undefined }, await savedYtIds(c.profile));
    relay(
      c,
      async (res) => {
        if (!res || res.error) return res;
        const have = await store.videosByYtIds(Array.isArray(res.picked) ? res.picked : []);
        const ids = await store.link(c.profile.id, have.map((v) => v.id), { category });
        // linked: the ones the library had already (another profile's): added here, not downloaded again
        const made = new Set((res.ids || []).map(String));
        return { ids, queued: ids.length, linked: ids.filter((id) => !made.has(String(id))).length, saved: res.saved, unavailable: res.unavailable };
      },
      linked,
    );
  }

  async function follow({ profile, args, reply }) {
    const { id, follow: on } = args[0] || {};
    const channel = isId(id) && (await store.channel(id));
    if (!channel) return reply({ error: "This channel no longer exists." });
    if (on) {
      // the first profile to follow a channel follows it in the library (which reads the channel once)
      if (!channel.follow) {
        const res = await upstream.followChannel(id, true);
        if (res?.error) return reply(res);
      }
      await store.follow(profile.id, id);
    } else {
      await store.unfollow(profile.id, id);
      // the last one to stop following ends the checks for new uploads
      if (channel.follow && !(await store.followers(id)).length) await upstream.followChannel(id, false);
    }
    reply({});
    await broadcast();
  }

  // Stop on a channel page: the profile's unfinished downloads of it; another profile's go on.
  async function stop({ profile, args, reply }) {
    const pending = isId(args[0]) ? await store.pendingOf(profile.id, args[0]) : [];
    for (const video of pending) await drop(profile, video);
    reply({ removed: pending.length });
    await broadcast();
  }

  async function remove({ profile, args, reply }) {
    if (isId(args[0]) && (await store.isMember(profile.id, args[0]))) await drop(profile, args[0]);
    reply();
    await broadcast();
  }

  async function setCategory({ profile, args, reply }) {
    const { id, category } = args[0] || {};
    if (!isId(id)) return reply();
    await store.setLink(profile.id, id, { category: (await ownCategory(profile, category)) || null });
    reply();
    await broadcast();
  }

  async function addCategory({ profile, args, reply }) {
    const name = categoryName(args[0]);
    if (!name) return reply({ error: "Give the category a name." });
    reply({ id: await store.addCategory(profile.id, name) });
    await broadcast();
  }

  // the videos stay, they just leave the category
  async function removeCategory({ profile, args, reply }) {
    if (isId(args[0])) await store.removeCategory(profile.id, args[0]);
    reply();
    await broadcast();
  }

  async function retry({ profile, args, reply, next }) {
    if (isId(args[0]) && (await store.isMember(profile.id, args[0]))) return next();
    reply();
  }

  // Kept for the profile, then passed on: the library's own fields read "someone watched it".
  async function watched({ profile, args, reply, next }) {
    const id = args[0];
    if (!isId(id) || !(await store.isMember(profile.id, id))) return reply();
    if (await store.isReady(id)) await store.setLink(profile.id, id, { watchedAt: Date.now() });
    next();
  }

  // Passed on too: the duplicate check waits while something plays (lib/dupes.js).
  async function position({ profile, args, reply, next }) {
    const { id, position: at } = args[0] || {};
    const seconds = Number(at);
    if (!isId(id) || !Number.isFinite(seconds) || seconds < 0 || !(await store.isMember(profile.id, id))) return reply();
    if (await store.isReady(id)) await store.setLink(profile.id, id, { position: Math.round(seconds) });
    next();
  }

  // profile:list → { profiles: [{ id, name, color, videos }], orphans }
  async function list({ reply }) {
    reply(await listing());
  }

  // profile:create { name, color } → { id, name, color }
  async function create({ args, reply }) {
    const data = args[0] || {};
    const name = profileName(data.name);
    if (!name) return reply({ error: ERRORS.name });
    if (await store.profileByKey(nameKey(name))) return reply({ error: ERRORS.taken });
    const profile = await store.createProfile({ name, nameKey: nameKey(name), color: pickColor(data.color, (await store.profiles()).length) });
    if (!profile) return reply({ error: ERRORS.taken });
    reply(profile);
    await announce();
  }

  // profile:update { id, name?, color?, kid? } → { id, name, color[, kid] }; kid only with HOMETUBE_KIDS on
  async function update({ args, reply }) {
    const data = args[0] || {};
    const profile = isId(data.id) && (await store.profileById(data.id));
    if (!profile) return reply({ error: ERRORS.pick });
    const fields = {};
    if (data.name !== undefined) {
      const name = profileName(data.name);
      if (!name) return reply({ error: ERRORS.name });
      const other = await store.profileByKey(nameKey(name));
      if (other && other.id !== profile.id) return reply({ error: ERRORS.taken });
      Object.assign(fields, { name, nameKey: nameKey(name) });
    }
    if (COLORS.includes(Number(data.color))) fields.color = Number(data.color);
    if (kids && typeof data.kid === "boolean") {
      if (data.kid && takesLastGrownUp(await store.profiles(), { id: profile.id, kid: true })) return reply({ error: KIDS_ERRORS.lastGrownUp });
      fields.kid = data.kid;
    }
    const saved = await store.updateProfile(profile.id, fields);
    if (!saved) return reply({ error: ERRORS.taken });
    reply(saved);
    await announce();
  }

  // profile:delete { id } → { orphans }. Its videos stay; the ones no other profile has become unassigned.
  async function forget({ args, reply }) {
    const id = typeof args[0] === "string" ? args[0] : args[0]?.id;
    const profile = isId(id) && (await store.profileById(id));
    if (!profile) return reply({ error: ERRORS.pick });
    if (kids && takesLastGrownUp(await store.profiles(), { id: profile.id, removed: true })) return reply({ error: KIDS_ERRORS.lastGrownUp });
    const follows = await store.follows(profile.id);
    await store.deleteProfile(profile.id);
    for (const channel of follows) {
      if ((await store.followers(channel)).length) continue;
      if ((await store.channel(channel))?.follow) await upstream.followChannel(channel, false);
    }
    reply({ orphans: await store.orphanCount() });
    await announce();
  }

  // profile:claim { profile, expect, categories } → { moved, categories, watched, follows }: the videos
  // no profile has move to this one, with where they were left. expect: how many there are now;
  // categories: false moves them without the library's categories. Moving again moves nothing twice.
  async function claim({ args, reply }) {
    const data = args[0] || {};
    const profile = isId(data.profile) && (await store.profileById(data.profile));
    if (!profile) return reply({ error: ERRORS.pick });
    const orphans = await store.orphans();
    if (data.expect !== orphans.length) return reply({ error: ERRORS.changed });
    const copy = data.categories !== false;
    const [oldCategories, have, followed] = await Promise.all([copy ? store.oldCategories() : [], store.categories(profile.id), store.unfollowedChannels()]);
    const plan = claimPlan({ orphans, oldCategories, have, followed, copy });
    const created = await store.addCategories(profile.id, plan.create);
    const ids = new Map([...have, ...created].map((c) => [c.name, c.id]));
    const moved = new Set(await store.claimLinks(profile.id, plan.links.map(({ categoryName: name, ...link }) => ({ ...link, category: ids.get(name) }))));
    for (const channel of plan.follows) await store.follow(profile.id, channel);
    reply({
      moved: moved.size,
      categories: created.length,
      watched: plan.links.filter((l) => l.watchedAt && moved.has(l.video)).length,
      follows: plan.follows.length,
    });
    await broadcast();
    await announce();
  }

  // With kids profiles on, profiles are marked and deleted one at a time: two at once can't both pass
  // takesLastGrownUp and leave only kids profiles.
  let turn = Promise.resolve();
  const oneAtATime = (handler) => (c) => {
    if (!kids) return handler(c);
    const run = turn.then(() => handler(c));
    turn = run.catch(() => {});
    return run;
  };

  const HANDLERS = {
    library: (c) => relay(c, (lib) => (Array.isArray(lib?.videos) ? viewOf(c.profile, lib) : lib)),
    storage: (c) => relay(c, async (st) => (Array.isArray(st?.channels) ? storageFor(st, await mine(c.profile)) : st)),
    "channel:browse": (c) => relay(c, async (res) => markSaved(res, new Set((await mine(c.profile)).map((v) => v.ytId)))),
    dupes: async (c) => {
      // the check sums up the profile's own videos only (kinds and shares too), so what another
      // profile saved never shows through; the answer is narrowed down to them as well
      const own = new Set((await mine(c.profile)).map((v) => v.id));
      const ack = typeof c.packet.at(-1) === "function" ? [c.packet.at(-1)] : [];
      c.packet.splice(1, c.packet.length - 1, c.args[0] ?? null, { only: own }, ...ack);
      relay(c, (res) => dupesFor(res, own));
    },
    "video:add": addVideo,
    "channel:download": download,
    "playlist:browse": playlistBrowse,
    "playlist:download": playlistDownload,
    "channel:follow": follow,
    "channel:stop": stop,
    "video:remove": remove,
    "video:category": setCategory,
    "category:add": addCategory,
    "category:remove": removeCategory,
    "video:retry": retry,
    "video:watched": watched,
    "video:position": position,
    "profile:list": list,
    "profile:create": create,
    "profile:update": oneAtATime(update),
    "profile:delete": oneAtATime(forget),
    "profile:claim": claim,
  };

  // socket.use: every event a client sends comes through here first (see ROUTES).
  async function route(socket, packet, next) {
    const [name, ...rest] = packet;
    const kind = ROUTES[name];
    if (!kind) return log.warn(`unrouted event ${name}`);
    const ack = typeof rest.at(-1) === "function" ? rest.at(-1) : undefined;
    const reply = once(ack);
    const profile = socket.data.profile;
    if (!profile && !OPEN.has(name)) return reply(name === "library" ? noProfile() : { error: ERRORS.pick });
    // a kids profile watches: whatever would change something is refused before anything runs
    if (kids && profile?.kid && !kidMay(name)) return reply({ error: KIDS_ERRORS.kid });
    // settings are shared, but saved with the cleanup rules off
    if (name === "settings:save" && packet[1] && typeof packet[1] === "object") packet[1] = lockedSettings(packet[1]);
    // shared events, and the storage page of a connection without a profile: the whole library's
    if (kind === "pass" || (kind === "wrap" && !profile)) return next();
    const handler = HANDLERS[name];
    if (!handler) return log.warn(`unrouted event ${name}`);
    try {
      await handler({ socket, profile, packet, args: ack ? rest.slice(0, -1) : rest, reply, next });
    } catch (err) {
      log.error(`${name} failed`, err.message);
      reply({ error: err.message });
    }
  }

  // startSync's queueUploads: a followed channel's new uploads go to every profile that follows it,
  // and so do the ones another profile has saved already.
  function forFollowers(queueUploads) {
    return async (channel, videos, options) => {
      const res = await queueUploads(channel, videos, options);
      try {
        const followers = await store.followers(String(channel._id));
        if (followers.length) {
          const ids = (await store.videosByYtIds(ytIdsOf(videos))).map((v) => v.id);
          for (const profile of followers) await store.link(profile, ids, {});
        }
      } catch (err) {
        log.error("linking new uploads failed", err.message);
      }
      return res;
    };
  }

  return { handshake, connect, route, broadcast, announce, forFollowers, HANDLERS };
}
