import assert from "node:assert/strict";
import { ROUTES, ERRORS, COLORS } from "./profileRules.js";
import { createGate, roomOf } from "./profileGate.js";

// The gate with the database, socket.io and the library's handlers faked: every path a profile
// takes, including the ones that would download from YouTube.

const T = 1_700_000_000_000;
let next = 0;
const newId = () => (++next).toString(16).padStart(24, "0");

// ---- the library's own data and handlers, as server.js keeps them ----
const db = { videos: [], channels: [], categories: [] };
const upstreamLog = { enqueued: [], removed: [], follow: [], retried: [], seen: [], dupes: [] };
const addChannel = (extra) => {
  const c = { id: newId(), name: "Channel", follow: false, updatedAt: T, ...extra };
  db.channels.push(c);
  return c;
};
const addVideo = (ytId, channel, extra) => {
  const v = { id: newId(), ytId, channel: channel.id, status: "ready", category: "", watchedAt: 0, position: 0, size: 100, short: false, savedAt: T, ...extra };
  db.videos.push(v);
  return v;
};
const library = async () => ({
  videos: db.videos.map((v) => ({ ...v })),
  channels: db.channels.map((c) => ({ id: c.id, name: c.name, follow: c.follow })),
  categories: db.categories.map((c) => ({ ...c })),
});
const idOf = (url) => /([\w-]{11})$/.exec(String(url || ""))?.[1];
// what YouTube lists for a channel's Shorts link (never asked for real)
let shortsListed = [];
const queue = (channel, ytIds, extra) => {
  const fresh = ytIds.filter((ytId) => !db.videos.some((v) => v.ytId === ytId));
  const created = fresh.map((ytId) => addVideo(ytId, channel, { status: "queued", ...extra }));
  return { ids: created.map((v) => v.id) };
};
const LISTENERS = {
  library: (ack) => library().then(ack),
  "video:add": (data, ack) => {
    upstreamLog.seen.push(["video:add", data]);
    if (/\/@\w+\/shorts$/.test(data.url)) {
      const channel = db.channels.find((c) => c.id === db.videos.find((v) => v.ytId === shortsListed[0])?.channel) || db.channels[0];
      channel.updatedAt = Date.now() + 1;
      const res = queue(channel, shortsListed, { short: true });
      if (!res.ids.length) return ack({ error: "All of this channel's Shorts are already in your library." });
      ack(res);
      return res.ids.forEach((id) => upstreamLog.enqueued.push(id));
    }
    const ytId = idOf(data.url);
    if (!ytId) return ack({ error: "Paste a YouTube video, Short or channel Shorts link." });
    if (db.videos.some((v) => v.ytId === ytId)) return ack({ error: "This video is already in your library." });
    const v = addVideo(ytId, db.channels[0], { status: "queued", category: data.category || "" });
    ack({ id: v.id });
    upstreamLog.enqueued.push(v.id);
  },
  "channel:download": (data, ack) => {
    upstreamLog.seen.push(["channel:download", data]);
    const channel = db.channels.find((c) => c.id === data.channel);
    if (!channel) return ack({ error: "This channel no longer exists." });
    const res = queue(channel, data.videos.map((v) => v.ytId), { category: data.category || "" });
    ack(res);
    res.ids.forEach((id) => upstreamLog.enqueued.push(id));
  },
  storage: (ack) => ack({ used: db.videos.reduce((n, v) => n + v.size, 0), free: 1, total: 2, channels: db.channels.map((c) => ({ id: c.id, name: c.name, count: db.videos.filter((v) => v.channel === c.id).length, size: db.videos.filter((v) => v.channel === c.id).reduce((n, v) => n + v.size, 0) })), cleanup: { count: 0, size: 0 } }),
  "channel:browse": (data, ack) => ack({ videos: db.videos.map((v) => ({ ytId: v.ytId, title: v.ytId, saved: true })).concat([{ ytId: "nnnnnnnnnnn", saved: false }]) }),
  // like lib/dupes.js: every video holds all the others it is asked about; scope.only stands for the library
  dupes: (...args) => {
    const ack = args.pop();
    const [id, scope] = args;
    upstreamLog.dupes.push(scope?.only ? [...scope.only].sort() : null);
    const ids = db.videos.map((v) => v.id).filter((vid) => !scope?.only || scope.only.has(vid));
    const of = (vid) => ({ id: vid, kind: "inside", coverage: 1, others: ids.filter((x) => x !== vid), partners: ids.filter((x) => x !== vid).map((x) => ({ id: x, here: [0, 600], there: 0, seconds: 600 })) });
    if (id) return ack(ids.includes(id) ? of(id) : { error: "This video no longer exists." });
    ack({ checked: ids.length, total: ids.length, videos: Object.fromEntries(ids.map((vid) => [vid, of(vid)])) });
  },
  "video:retry": (id, ack) => {
    upstreamLog.retried.push(id);
    ack();
  },
  "video:watched": (id, ack) => {
    db.videos.find((v) => v.id === id).watchedAt = Date.now();
    ack();
  },
  "video:position": ({ id, position }, ack) => {
    db.videos.find((v) => v.id === id).position = position;
    ack?.();
  },
  settings: (ack) => ack({ shared: true }),
  "settings:save": (data, ack) => {
    upstreamLog.seen.push(["settings:save", data]);
    ack({ shared: true });
  },
  "storage:cleanup": (ack) => ack({ removed: 0 }),
  "channel:refresh": (id, ack) => ack({}),
};
const upstream = {
  library,
  removeVideo: async (id) => {
    upstreamLog.removed.push(id);
    db.videos = db.videos.filter((v) => v.id !== id);
  },
  followChannel: async (id, follow) => {
    upstreamLog.follow.push([id, follow]);
    db.channels.find((c) => c.id === id).follow = follow;
    return {};
  },
};

// ---- the profile collections, in memory (lib/profiles.js keeps them in MongoDB) ----
const mem = { profiles: [], links: [], cats: [], follows: [] };
const wire = (p) => ({ id: p.id, name: p.name, color: p.color });
const linked = () => new Set(mem.links.map((l) => l.video));
const store = {
  profiles: async () => mem.profiles.map(wire),
  profileById: async (id) => mem.profiles.find((p) => p.id === id) && wire(mem.profiles.find((p) => p.id === id)),
  profileByKey: async (key) => (key && mem.profiles.find((p) => p.nameKey === key) ? wire(mem.profiles.find((p) => p.nameKey === key)) : null),
  createProfile: async (fields) => {
    if (mem.profiles.some((p) => p.nameKey === fields.nameKey)) return null;
    const p = { id: newId(), ...fields };
    mem.profiles.push(p);
    return wire(p);
  },
  updateProfile: async (id, fields) => {
    const p = mem.profiles.find((x) => x.id === id);
    Object.assign(p, fields);
    return wire(p);
  },
  deleteProfile: async (id) => {
    mem.links = mem.links.filter((l) => l.profile !== id);
    mem.cats = mem.cats.filter((c) => c.profile !== id);
    mem.follows = mem.follows.filter((f) => f.profile !== id);
    mem.profiles = mem.profiles.filter((p) => p.id !== id);
  },
  videoCounts: async () => mem.links.reduce((m, l) => m.set(l.profile, (m.get(l.profile) || 0) + 1), new Map()),
  orphanCount: async () => db.videos.filter((v) => !linked().has(v.id)).length,
  orphans: async () => db.videos.filter((v) => !linked().has(v.id)).map((v) => ({ id: v.id, category: v.category, watchedAt: v.watchedAt, position: v.position, addedAt: v.savedAt })),
  oldCategories: async () => db.categories.map((c) => ({ id: c.id, name: c.name })),
  unfollowedChannels: async () => db.channels.filter((c) => c.follow && !mem.follows.some((f) => f.channel === c.id)).map((c) => c.id),
  links: async (profile) => mem.links.filter((l) => l.profile === profile).map((l) => ({ ...l })),
  isMember: async (profile, video) => mem.links.some((l) => l.profile === profile && l.video === video),
  link: async (profile, videos, { category } = {}) => {
    const fresh = [...new Set(videos)].filter((video) => !mem.links.some((l) => l.profile === profile && l.video === video));
    fresh.forEach((video) => mem.links.push({ profile, video, category: category || "", watchedAt: 0, position: 0, addedAt: Date.now() }));
    return fresh;
  },
  claimLinks: async (profile, links) => {
    const fresh = links.filter((l) => !mem.links.some((x) => x.profile === profile && x.video === l.video));
    fresh.forEach((l) => mem.links.push({ profile, ...l, category: l.category || "" }));
    return fresh.map((l) => l.video);
  },
  unlink: async (profile, video) => {
    const before = mem.links.length;
    mem.links = mem.links.filter((l) => !(l.profile === profile && l.video === video));
    return mem.links.length < before;
  },
  linkCount: async (video) => mem.links.filter((l) => l.video === video).length,
  setLink: async (profile, video, fields) => {
    const l = mem.links.find((x) => x.profile === profile && x.video === video);
    if (!l) return false;
    if ("category" in fields) l.category = fields.category || "";
    if (fields.watchedAt) l.watchedAt = fields.watchedAt;
    if (fields.position !== undefined) l.position = fields.position;
    return true;
  },
  pendingOf: async (profile, channel) =>
    db.videos.filter((v) => v.channel === channel && ["queued", "waiting", "downloading"].includes(v.status) && mem.links.some((l) => l.profile === profile && l.video === v.id)).map((v) => v.id),
  memberVideos: async (profile) => db.videos.filter((v) => mem.links.some((l) => l.profile === profile && l.video === v.id)).map((v) => ({ id: v.id, ytId: v.ytId, channel: v.channel, size: v.size })),
  videoByYtId: async (ytId) => (db.videos.find((v) => v.ytId === ytId) ? { id: db.videos.find((v) => v.ytId === ytId).id } : null),
  videosByYtIds: async (ytIds) => db.videos.filter((v) => ytIds.includes(v.ytId)).map((v) => ({ id: v.id, ytId: v.ytId })),
  isReady: async (video) => db.videos.some((v) => v.id === video && v.status === "ready"),
  channel: async (id) => (db.channels.find((c) => c.id === id) ? { id, follow: db.channels.find((c) => c.id === id).follow } : null),
  channelsSince: async (date) => db.channels.filter((c) => c.updatedAt >= date.getTime()).map((c) => c.id),
  shortsOf: async (channels) => db.videos.filter((v) => channels.includes(v.channel) && v.short).map((v) => v.id),
  categories: async (profile) => mem.cats.filter((c) => c.profile === profile).map((c) => ({ id: c.id, name: c.name })),
  hasCategory: async (profile, id) => mem.cats.some((c) => c.profile === profile && c.id === id),
  addCategory: async (profile, name) => {
    const c = { id: newId(), profile, name };
    mem.cats.push(c);
    return c.id;
  },
  addCategories: async (profile, list) => list.map((x) => (mem.cats.push({ id: newId(), profile, ...x }), { id: mem.cats.at(-1).id, name: x.name })),
  removeCategory: async (profile, id) => {
    mem.cats = mem.cats.filter((c) => !(c.profile === profile && c.id === id));
    mem.links.filter((l) => l.profile === profile && l.category === id).forEach((l) => (l.category = ""));
  },
  follows: async (profile) => mem.follows.filter((f) => f.profile === profile).map((f) => f.channel),
  followers: async (channel) => mem.follows.filter((f) => f.channel === channel).map((f) => f.profile),
  follow: async (profile, channel) => {
    if (!mem.follows.some((f) => f.profile === profile && f.channel === channel)) mem.follows.push({ profile, channel });
  },
  unfollow: async (profile, channel) => {
    mem.follows = mem.follows.filter((f) => !(f.profile === profile && f.channel === channel));
  },
};

// ---- socket.io, faked ----
const rooms = new Map();
const sockets = new Map();
const io = {
  sockets: { sockets, adapter: { rooms } },
  to: (room) => ({ emit: (name, payload) => (rooms.get(room) || new Set()).forEach((id) => sockets.get(id).got.push([name, payload])) }),
};
const warnings = [];
const errors = [];
const log = { warn: (m) => warnings.push(m), error: (...m) => errors.push(m.join(" ")), log: () => {} };
const gate = createGate({ store, io, upstream, log });

let sid = 0;
async function connect(auth = {}) {
  const socket = {
    id: `s${++sid}`,
    data: {},
    handshake: { auth },
    got: [],
    join(room) {
      (rooms.get(room) || rooms.set(room, new Set()).get(room)).add(this.id);
    },
    leave(room) {
      rooms.get(room)?.delete(this.id);
      if (!rooms.get(room)?.size) rooms.delete(room);
    },
    emit(name, payload) {
      this.got.push([name, payload]);
    },
    use(fn) {
      this.middleware = fn;
    },
  };
  await gate.handshake(socket);
  sockets.set(socket.id, socket);
  gate.connect(socket);
  return socket;
}
const last = (socket, name) => socket.got.filter(([n]) => n === name).at(-1)?.[1];
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// Sends an event through the gate: { res, passed } (passed: the library's handler ran).
async function send(socket, name, ...args) {
  let passed = false;
  const answered = new Promise((resolve) => {
    const packet = [name, ...args, (res) => resolve(res)];
    socket.middleware(packet, () => {
      passed = true;
      LISTENERS[name](...packet.slice(1));
    });
  });
  const res = await Promise.race([answered, settle().then(() => settle()).then(() => "no answer")]);
  await settle();
  return { res, passed };
}

// ---- the library before profiles ----
const c1 = addChannel({ name: "One" });
const c2 = addChannel({ name: "Two" });
const oldCartoons = { id: newId(), name: "Cartoons" };
db.categories.push(oldCartoons, { id: newId(), name: "Music" });
const v1 = addVideo("aaaaaaaaaaa", c1, { category: oldCartoons.id, watchedAt: T, position: 40, savedAt: T - 3 });
const v2 = addVideo("bbbbbbbbbbb", c1, { savedAt: T - 2 });
const v3 = addVideo("ccccccccccc", c2, { short: true, savedAt: T - 1 });

// every routed event that needs the profile layer has a handler
for (const [name, kind] of Object.entries(ROUTES)) if (kind !== "pass") assert.ok(gate.HANDLERS[name], `${name} has no handler`);

// 18: without a profile: told so, the library stays shut and writes are refused
const tv = await connect();
assert.deepEqual(last(tv, "profiles"), { current: null, list: [], orphans: 3 });
assert.deepEqual((await send(tv, "library")).res, { error: ERRORS.pick, videos: [], channels: [], categories: [] });
for (const [name, arg] of [["video:add", { url: "aaaaaaaaaaa" }], ["video:remove", v1.id], ["category:add", "X"], ["settings:save", {}], ["storage:cleanup"], ["channel:refresh", c1.id]]) {
  const { res, passed } = await send(tv, name, ...(arg === undefined ? [] : [arg]));
  assert.deepEqual([res, passed], [{ error: ERRORS.pick }, false], name);
}
// shared reads still work
assert.deepEqual((await send(tv, "settings")).res, { shared: true });
assert.equal((await send(tv, "storage")).res.mine, undefined);
// an event nobody routed never reaches a handler
const stray = await send(tv, "video:stray", 1);
assert.deepEqual([stray.res, stray.passed, warnings], ["no answer", false, ["unrouted event video:stray"]]);

// creating profiles: a name is needed and taken once whatever its case
assert.deepEqual((await send(tv, "profile:create", { name: "  " })).res, { error: ERRORS.name });
const alice = (await send(tv, "profile:create", { name: " Alice " })).res;
assert.deepEqual(alice, { id: alice.id, name: "Alice", color: COLORS[0] });
assert.deepEqual((await send(tv, "profile:create", { name: "ALICE" })).res, { error: ERRORS.taken });
const kid = (await send(tv, "profile:create", { name: "Kid", color: COLORS[3] })).res;
assert.equal(kid.color, COLORS[3]);
// everyone is told about the new list
assert.deepEqual(last(tv, "profiles").list.map((p) => [p.name, p.videos]), [["Alice", 0], ["Kid", 0]]);
assert.deepEqual((await send(tv, "profile:list")).res, { profiles: [{ ...alice, videos: 0 }, { ...kid, videos: 0 }], orphans: 3 });

// moving the unassigned videos: only with the right count, without categories when asked
assert.deepEqual((await send(tv, "profile:claim", { profile: alice.id, expect: 2, categories: false })).res, { error: ERRORS.changed });
assert.deepEqual((await send(tv, "profile:claim", { profile: newId(), expect: 3 })).res, { error: ERRORS.pick });
assert.deepEqual((await send(tv, "profile:claim", { profile: alice.id, expect: 3, categories: false })).res, { moved: 3, categories: 0, watched: 1, follows: 0 });
assert.deepEqual((await send(tv, "profile:claim", { profile: alice.id, expect: 0, categories: false })).res, { moved: 0, categories: 0, watched: 0, follows: 0 });
// a connection asks for its profile by name or by id
const aliceTv = await connect({ profile: "alice" });
assert.deepEqual(last(aliceTv, "profiles").current, alice);
let lib = (await send(aliceTv, "library")).res;
assert.deepEqual(lib.videos.map((v) => v.id), [v3.id, v2.id, v1.id]);
assert.deepEqual([lib.categories, lib.videos[2].category, lib.videos[2].watchedAt, lib.videos[2].position, lib.videos[2].savedAt], [[], "", T, 40, T - 3]);
const kidPhone = await connect({ profile: kid.id });
assert.deepEqual((await send(kidPhone, "library")).res.videos, []);
// an unknown profile: back to picking one
const lost = await connect({ profile: newId() });
assert.deepEqual([last(lost, "profiles").current, last(lost, "profiles").reason], [null, "removed"]);

// 16 + 20: deleting a profile leaves its videos unassigned; a TV watching as it goes back to picking
assert.deepEqual((await send(tv, "profile:delete", { id: alice.id })).res, { orphans: 3 });
assert.deepEqual([last(aliceTv, "profiles").current, last(aliceTv, "profiles").reason], [null, "removed"]);
assert.equal(rooms.has(roomOf(alice.id)), false);
assert.deepEqual((await send(aliceTv, "library")).res.error, ERRORS.pick);
assert.equal(db.videos.length, 3);
assert.equal(upstreamLog.removed.length, 0);
// moving with the library's categories: copied by name, the videos keep theirs
assert.deepEqual((await send(tv, "profile:claim", { profile: kid.id, expect: 3 })).res, { moved: 3, categories: 2, watched: 1, follows: 0 });
assert.deepEqual((await send(tv, "profile:claim", { profile: kid.id, expect: 0 })).res, { moved: 0, categories: 0, watched: 0, follows: 0 });
lib = (await send(kidPhone, "library")).res;
const kidCartoons = lib.categories.find((c) => c.name === "Cartoons");
assert.deepEqual(lib.categories.map((c) => c.name), ["Cartoons", "Music"]);
assert.equal(lib.videos.find((v) => v.id === v1.id).category, kidCartoons.id);

// Alice again, on another TV
const alice2 = (await send(tv, "profile:create", { name: "Alice" })).res;
const aliceTv2 = await connect({ profile: alice2.id });
const aliceShows = (await send(aliceTv2, "category:add", "Shows")).res.id;
assert.deepEqual((await send(aliceTv2, "category:add", "  ")).res, { error: "Give the category a name." });

// 1: a video another profile has is linked: nothing is downloaded again
let r = await send(aliceTv2, "video:add", { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", category: aliceShows });
assert.deepEqual([r.res, r.passed, upstreamLog.enqueued], [{ id: v1.id }, false, []]);
// 12: each profile gets its own library broadcast, a connection without one gets none
assert.deepEqual(last(aliceTv2, "library").videos.map((v) => [v.id, v.category]), [[v1.id, aliceShows]]);
assert.equal(tv.got.filter(([n]) => n === "library").length, 0);
// K10: adding a video the profile has: the library's own answer, word for word
r = await send(aliceTv2, "video:add", { url: "aaaaaaaaaaa" });
assert.deepEqual([r.res, r.passed], [{ error: "This video is already in your library." }, true]);
// a new video: the library creates and queues it, the profile's category stays on its link
r = await send(aliceTv2, "video:add", { url: "https://youtu.be/ddddddddddd", category: aliceShows });
const v4 = db.videos.find((v) => v.ytId === "ddddddddddd");
assert.deepEqual([r.res, r.passed, upstreamLog.enqueued], [{ id: v4.id }, true, [v4.id]]);
assert.equal(upstreamLog.seen.at(-1)[1].category, undefined);
assert.equal(v4.category, "");
assert.equal((await store.links(alice2.id)).find((l) => l.video === v4.id).category, aliceShows);
// a category from another profile isn't taken
await send(aliceTv2, "video:add", { url: "eeeeeeeeeee", category: kidCartoons.id });
const vE = db.videos.find((v) => v.ytId === "eeeeeeeeeee");
assert.equal((await store.links(alice2.id)).find((l) => l.video === vE.id).category, "");

// 11: a channel's Shorts link whose Shorts are all saved, one of them only by Kid
shortsListed = [v3.ytId];
r = await send(aliceTv2, "video:add", { url: "https://www.youtube.com/@one/shorts" });
assert.deepEqual(r.res, { error: ERRORS.shorts });
// once the profile has them all, the library's own answer
await send(aliceTv2, "video:add", { url: v3.ytId });
r = await send(aliceTv2, "video:add", { url: "https://www.youtube.com/@one/shorts" });
assert.deepEqual(r.res, { error: "All of this channel's Shorts are already in your library." });
// new Shorts are queued by the library and linked
shortsListed = [v3.ytId, "sssssssssss"];
r = await send(aliceTv2, "video:add", { url: "https://www.youtube.com/@one/shorts" });
const short = db.videos.find((v) => v.ytId === "sssssssssss");
assert.deepEqual(r.res, { ids: [short.id] });
assert.ok(await store.isMember(alice2.id, short.id));

// 10: Get videos: the ones saved already are linked, the new ones queued once
upstreamLog.enqueued = [];
r = await send(aliceTv2, "channel:download", { channel: c1.id, videos: [{ ytId: v2.ytId }, { ytId: "fffffffffff" }], category: aliceShows, shorts: false });
const v5 = db.videos.find((v) => v.ytId === "fffffffffff");
assert.deepEqual([r.res.ids.sort(), upstreamLog.enqueued], [[v2.id, v5.id].sort(), [v5.id]]);
assert.equal(upstreamLog.seen.at(-1)[1].category, undefined);
assert.equal((await store.links(alice2.id)).find((l) => l.video === v2.id).category, aliceShows);

// 2: a video still downloading for Kid is linked to Alice too
const v6 = addVideo("ggggggggggg", c2, { status: "downloading" });
await store.link(kid.id, [v6.id]);
r = await send(aliceTv2, "video:add", { url: v6.ytId });
assert.deepEqual([r.res, r.passed], [{ id: v6.id }, false]);

// 3: retrying a download: any profile that has it, no one else
const nobody = await connect({ profile: (await send(tv, "profile:create", { name: "Guest" })).res.id });
assert.deepEqual([(await send(nobody, "video:retry", v6.id)).passed, (await send(kidPhone, "video:retry", v6.id)).passed], [false, true]);

// 4: the same video in two categories, one per profile; the video itself keeps its own
await send(kidPhone, "video:category", { id: v1.id, category: kidCartoons.id });
await send(aliceTv2, "video:category", { id: v1.id, category: aliceShows });
assert.equal((await send(kidPhone, "library")).res.videos.find((v) => v.id === v1.id).category, kidCartoons.id);
assert.equal((await send(aliceTv2, "library")).res.videos.find((v) => v.id === v1.id).category, aliceShows);
assert.equal(v1.category, oldCartoons.id);
await send(aliceTv2, "category:remove", aliceShows);
assert.equal((await send(aliceTv2, "library")).res.videos.find((v) => v.id === v1.id).category, "");

// 5: watched and where playback was left belong to the profile; the library hears of it too
r = await send(aliceTv2, "video:watched", v2.id);
assert.equal(r.passed, true);
const aliceV2 = (await send(aliceTv2, "library")).res.videos.find((v) => v.id === v2.id);
const kidV2 = (await send(kidPhone, "library")).res.videos.find((v) => v.id === v2.id);
assert.ok(aliceV2.watchedAt > T && kidV2.watchedAt === 0);
assert.equal((await send(aliceTv2, "video:position", { id: v2.id, position: 61.6 })).passed, true);
assert.deepEqual([(await store.links(alice2.id)).find((l) => l.video === v2.id).position, (await store.links(kid.id)).find((l) => l.video === v2.id).position], [62, 0]);
// no answer asked for: fine (the player sends positions that way)
let positioned = false;
await aliceTv2.middleware(["video:position", { id: v2.id, position: 70 }], () => (positioned = true));
assert.equal(positioned, true);
// a video the profile doesn't have isn't touched
assert.equal((await send(nobody, "video:position", { id: v2.id, position: 5 })).passed, false);
assert.equal((await send(nobody, "video:watched", v2.id)).passed, false);

// 6: removing: the link goes; the last profile to let go deletes the video and its files
await send(kidPhone, "video:remove", v1.id);
assert.deepEqual([await store.isMember(kid.id, v1.id), upstreamLog.removed], [false, []]);
await send(nobody, "video:remove", v1.id);
assert.deepEqual(upstreamLog.removed, []);
await send(aliceTv2, "video:remove", v1.id);
assert.deepEqual(upstreamLog.removed, [v1.id]);

// stopping a channel's downloads: the profile's links go, a download another profile has goes on
const v7 = addVideo("hhhhhhhhhhh", c2, { status: "queued" });
await store.link(alice2.id, [v7.id]);
// pending for Alice on that channel: v6 (Kid has it too), the new Short and v7
assert.deepEqual((await send(aliceTv2, "channel:stop", c2.id)).res, { removed: 3 });
assert.deepEqual(upstreamLog.removed.sort(), [v1.id, short.id, v7.id].sort());
assert.ok(db.videos.some((v) => v.id === v6.id));
assert.equal(await store.isMember(alice2.id, v6.id), false);

// 7: a channel page marks saved what the profile has
const browse = (await send(kidPhone, "channel:browse", { id: c1.id, tab: "videos" })).res;
assert.deepEqual(browse.videos.filter((u) => u.saved).map((u) => u.ytId).sort(), [v2.ytId, v3.ytId, v6.ytId].sort());

// 8: a profile's channels are those of its videos (and of its follows); one leaves with its last video there
const kidChannels = async () => (await send(kidPhone, "library")).res.channels.map((c) => c.id).sort();
assert.deepEqual(await kidChannels(), [c1.id, c2.id].sort());
await send(kidPhone, "video:remove", v3.id);
await send(kidPhone, "video:remove", v6.id);
assert.deepEqual(await kidChannels(), [c1.id]);
assert.ok((await send(aliceTv2, "library")).res.channels.some((c) => c.id === c2.id));

// 9: following: the first profile follows in the library, the last one to stop ends it
upstreamLog.follow = [];
await send(aliceTv2, "channel:follow", { id: c2.id, follow: true });
await send(kidPhone, "channel:follow", { id: c2.id, follow: true });
assert.deepEqual(upstreamLog.follow, [[c2.id, true]]);
assert.equal((await send(kidPhone, "library")).res.channels.find((c) => c.id === c2.id).follow, true);
assert.equal((await send(nobody, "library")).res.channels.some((c) => c.id === c2.id), false);
assert.deepEqual((await send(kidPhone, "channel:follow", { id: newId(), follow: true })).res, { error: "This channel no longer exists." });
// a followed channel's new uploads (and ones another profile has) go to every follower
const queueUploads = gate.forFollowers(async (channel, videos) => queue(channel, videos.map((v) => v.ytId)));
const synced = await queueUploads({ _id: c2.id }, [{ ytId: "iiiiiiiiiii" }, { ytId: v4.ytId }], { shorts: false });
const v8 = db.videos.find((v) => v.ytId === "iiiiiiiiiii");
assert.deepEqual(synced, { ids: [v8.id] });
for (const p of [alice2.id, kid.id]) assert.ok((await store.isMember(p, v8.id)) && (await store.isMember(p, v4.id)), p);
assert.equal(await store.isMember(nobody.data.profile.id, v8.id), false);
await send(aliceTv2, "channel:follow", { id: c2.id, follow: false });
assert.deepEqual(upstreamLog.follow, [[c2.id, true]]);
await send(kidPhone, "channel:follow", { id: c2.id, follow: false });
assert.deepEqual(upstreamLog.follow, [[c2.id, true], [c2.id, false]]);

// 13: storage: the disk is shared, "mine" is the profile's share
const st = (await send(kidPhone, "storage")).res;
assert.equal(st.used, db.videos.reduce((n, v) => n + v.size, 0));
assert.deepEqual(st.mine, { used: (await store.memberVideos(kid.id)).length * 100, count: (await store.memberVideos(kid.id)).length });

// 14: cleanup and settings are shared and pass on; settings are saved with both cleanup rules off
assert.deepEqual([(await send(kidPhone, "storage:cleanup")).passed, (await send(kidPhone, "settings:save", { quality: 1080, deleteWatchedDays: 7, keepPerChannel: 10 })).passed], [true, true]);
assert.deepEqual(upstreamLog.seen.at(-1), ["settings:save", { quality: 1080, deleteWatchedDays: 0, keepPerChannel: 0 }]);

// 15: duplicates only among the profile's own videos
const dupes = (await send(nobody, "dupes")).res;
assert.deepEqual([dupes.total, Object.keys(dupes.videos)], [0, []]);
assert.deepEqual(Object.keys((await send(kidPhone, "dupes")).res.videos).sort(), (await store.memberVideos(kid.id)).map((v) => v.id).sort());
// the check itself is told which videos count, so kinds and shares come from the profile's own videos;
// a scope the client sends along is replaced
const kidIds = (await store.memberVideos(kid.id)).map((v) => v.id).sort();
const outside = db.videos.find((v) => !kidIds.includes(v.id));
assert.ok(kidIds.length && outside);
assert.deepEqual(upstreamLog.dupes.at(-1), kidIds);
upstreamLog.dupes = [];
const kidDupes = (await send(kidPhone, "dupes", null, { only: new Set(db.videos.map((v) => v.id)) })).res;
assert.deepEqual(upstreamLog.dupes, [kidIds]);
const named = Object.values(kidDupes.videos).flatMap((d) => [d.id, ...d.others, ...d.partners.map((p) => p.id)]);
assert.deepEqual(named.filter((id) => !kidIds.includes(id)), []);
// one video: only one of the profile's own
assert.deepEqual((await send(kidPhone, "dupes", outside.id)).res, { error: "This video no longer exists." });
assert.equal((await send(kidPhone, "dupes", kidIds[0])).res.id, kidIds[0]);
// without a profile there's nothing to ask about
assert.deepEqual((await send(await connect(), "dupes")).res, { error: ERRORS.pick });

// renaming: names stay unique, connections learn the new name
assert.deepEqual((await send(tv, "profile:update", { id: kid.id, name: "alice" })).res, { error: ERRORS.taken });
assert.deepEqual((await send(tv, "profile:update", { id: kid.id, name: "Kiddo", color: COLORS[5] })).res, { id: kid.id, name: "Kiddo", color: COLORS[5] });
assert.deepEqual(kidPhone.data.profile, { id: kid.id, name: "Kiddo", color: COLORS[5] });
assert.equal(last(kidPhone, "profiles").current.name, "Kiddo");

// 20 again: Kid's phone, watching as Kid, when Kid is deleted elsewhere
const kidLinks = (await store.links(kid.id)).length;
assert.ok(kidLinks > 0);
await send(tv, "profile:delete", kid.id);
assert.deepEqual([kidPhone.data.profile, last(kidPhone, "profiles").reason], [null, "removed"]);
assert.equal(last(aliceTv2, "profiles").reason, undefined);
assert.deepEqual(errors, []);

console.log("profile gate ok");
