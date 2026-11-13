import assert from "node:assert/strict";
import { ROUTES, KIDS, KIDS_ERRORS, ERRORS, COLORS, kidMay, profileWire } from "./profileRules.js";
import { createGate } from "./profileGate.js";

// Kids profiles (HOMETUBE_KIDS=1) through the gate, with the database, socket.io and the library's
// handlers faked: a kids profile is refused whatever would change something and nothing is written,
// a grown-up's profile goes on as before, the last grown-up stays one, and without the flag none of
// it shows.

let next = 0;
const newId = () => (++next).toString(16).padStart(24, "0");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function setup({ kids }) {
  // ---- the library: its data, and a record of every handler of its that ran ----
  const db = { videos: [], channels: [], settings: { quality: 1080 } };
  const ran = [];
  const addChannel = () => {
    const c = { id: newId(), name: "Channel", follow: false, refreshed: 0 };
    db.channels.push(c);
    return c;
  };
  const addVideo = (ytId, channel, extra) => {
    const v = { id: newId(), ytId, channel: channel.id, status: "ready", watchedAt: 0, position: 0, size: 100, short: false, savedAt: 1, ...extra };
    db.videos.push(v);
    return v;
  };
  const library = async () => ({ videos: db.videos.map((v) => ({ ...v })), channels: db.channels.map((c) => ({ id: c.id, name: c.name, follow: c.follow })), categories: [] });
  const queue = (ytIds) => ({ ids: ytIds.filter((ytId) => !db.videos.some((v) => v.ytId === ytId)).map((ytId) => addVideo(ytId, db.channels[0], { status: "queued" }).id) });
  const LISTENERS = {
    library: (ack) => library().then(ack),
    "video:add": (data, ack) => {
      const { ids } = queue([/([\w-]{11})$/.exec(data.url)[1]]);
      ack(ids.length ? { id: ids[0] } : { error: "This video is already in your library." });
    },
    "channel:download": (data, ack) => ack(queue(data.videos.map((v) => v.ytId))),
    "playlist:browse": (data, scope, ack) => ack({ videos: [{ ytId: "ppppppppppp", saved: scope.saved.has("ppppppppppp") }] }),
    "playlist:download": (data, scope, ack) => ack({ ...queue(data.videos), picked: data.videos, saved: 0, unavailable: 0 }),
    settings: (ack) => ack({ ...db.settings }),
    "settings:save": (data, ack) => ack((db.settings = { ...data })),
    storage: (ack) => ack({ used: 1, free: 1, total: 2, channels: [], cleanup: { count: 0, size: 0 } }),
    "storage:cleanup": (ack) => ack({ removed: 0 }),
    "channel:browse": (data, ack) => ack({ videos: [] }),
    "channel:refresh": (id, ack) => {
      db.channels.find((c) => c.id === id).refreshed += 1;
      ack({});
    },
    "video:retry": (id, ack) => {
      db.videos.find((v) => v.id === id).status = "queued";
      ack();
    },
    "video:watched": (id, ack) => {
      db.videos.find((v) => v.id === id).watchedAt = 1;
      ack();
    },
    "video:position": ({ id, position }, ack) => {
      db.videos.find((v) => v.id === id).position = position;
      ack?.();
    },
    dupes: (...args) => args.pop()({ checked: 0, total: 0, videos: {} }),
  };
  const upstream = {
    library,
    removeVideo: async (id) => {
      ran.push(["removeVideo", id]);
      db.videos = db.videos.filter((v) => v.id !== id);
    },
    followChannel: async (id, follow) => {
      ran.push(["followChannel", id, follow]);
      db.channels.find((c) => c.id === id).follow = follow;
      return {};
    },
  };

  // ---- the profile collections, in memory; profiles go out as lib/profiles.js sends them ----
  const mem = { profiles: [], links: [], cats: [], follows: [] };
  const updates = [];
  const wire = (p) => profileWire({ _id: p.id, ...p }, kids);
  const linked = () => new Set(mem.links.map((l) => l.video));
  const store = {
    profiles: async () => mem.profiles.map(wire),
    profileById: async (id) => (mem.profiles.find((p) => p.id === id) ? wire(mem.profiles.find((p) => p.id === id)) : null),
    profileByKey: async (key) => (key && mem.profiles.find((p) => p.nameKey === key) ? wire(mem.profiles.find((p) => p.nameKey === key)) : null),
    createProfile: async (fields) => {
      const p = { id: newId(), ...fields };
      mem.profiles.push(p);
      return wire(p);
    },
    updateProfile: async (id, fields) => {
      updates.push({ id, ...fields });
      const p = mem.profiles.find((x) => x.id === id);
      Object.assign(p, fields);
      return wire(p);
    },
    deleteProfile: async (id) => {
      for (const key of ["links", "cats", "follows"]) mem[key] = mem[key].filter((x) => x.profile !== id);
      mem.profiles = mem.profiles.filter((p) => p.id !== id);
    },
    videoCounts: async () => mem.links.reduce((m, l) => m.set(l.profile, (m.get(l.profile) || 0) + 1), new Map()),
    orphanCount: async () => db.videos.filter((v) => !linked().has(v.id)).length,
    orphans: async () => db.videos.filter((v) => !linked().has(v.id)).map((v) => ({ id: v.id, category: "", watchedAt: 0, position: 0, addedAt: 1 })),
    oldCategories: async () => [],
    unfollowedChannels: async () => [],
    links: async (profile) => mem.links.filter((l) => l.profile === profile).map((l) => ({ ...l })),
    isMember: async (profile, video) => mem.links.some((l) => l.profile === profile && l.video === video),
    link: async (profile, videos, { category } = {}) => {
      const fresh = [...new Set(videos)].filter((video) => !mem.links.some((l) => l.profile === profile && l.video === video));
      fresh.forEach((video) => mem.links.push({ profile, video, category: category || "", watchedAt: 0, position: 0, addedAt: 1 }));
      return fresh;
    },
    claimLinks: async () => [],
    unlink: async (profile, video) => {
      mem.links = mem.links.filter((l) => !(l.profile === profile && l.video === video));
      return true;
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
    channelsSince: async () => [],
    shortsOf: async () => [],
    categories: async (profile) => mem.cats.filter((c) => c.profile === profile).map((c) => ({ id: c.id, name: c.name })),
    hasCategory: async (profile, id) => mem.cats.some((c) => c.profile === profile && c.id === id),
    addCategory: async (profile, name) => {
      const c = { id: newId(), profile, name };
      mem.cats.push(c);
      return c.id;
    },
    addCategories: async () => [],
    removeCategory: async (profile, id) => {
      mem.cats = mem.cats.filter((c) => !(c.profile === profile && c.id === id));
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
  const errors = [];
  const log = { warn: (m) => errors.push(m), error: (...m) => errors.push(m.join(" ")), log: () => {} };
  const gate = createGate({ store, io, upstream, log, kids });
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
  // { res, passed }: passed when the library's own handler ran
  async function send(socket, name, ...args) {
    let passed = false;
    const answered = new Promise((resolve) => {
      const packet = [name, ...args, (res) => resolve(res)];
      socket.middleware(packet, () => {
        passed = true;
        ran.push([name]);
        LISTENERS[name](...packet.slice(1));
      });
    });
    const res = await Promise.race([answered, settle().then(settle).then(() => "no answer")]);
    await settle();
    return { res, passed };
  }
  // everything an event could have written, in one string
  const state = () => JSON.stringify({ db, mem, ran, updates });
  const last = (socket, name) => socket.got.filter(([n]) => n === name).at(-1)?.[1];
  return { db, mem, ran, updates, errors, store, gate, addChannel, addVideo, connect, send, state, last };
}

// ==================== HOMETUBE_KIDS on ====================
const t = setup({ kids: true });
const c1 = t.addChannel();
const v1 = t.addVideo("aaaaaaaaaaa", c1);
const v2 = t.addVideo("bbbbbbbbbbb", c1);
const failed = t.addVideo("fffffffffff", c1, { status: "failed" });
const tv = await t.connect();
const grown = (await t.send(tv, "profile:create", { name: "Alice" })).res;
const child = (await t.send(tv, "profile:create", { name: "Kid", color: COLORS[3] })).res;
// with the flag on every profile says whether it's a kids profile; a new one never is
assert.deepEqual([grown.kid, child.kid], [false, false]);
assert.ok(t.last(tv, "profiles").list.every((p) => p.kid === false));
for (const p of [grown, child]) await t.store.link(p.id, [v1.id, v2.id, failed.id]);
const aliceTv = await t.connect({ profile: grown.id });
const kidTv = await t.connect({ profile: child.id });
const own = {
  [grown.id]: { cat: await t.store.addCategory(grown.id, "Shows") },
  [child.id]: { cat: await t.store.addCategory(child.id, "Cartoons") },
};

// a grown-up marks the kids profile; a TV already watching as it is told at once, and keeps it
let r = await t.send(aliceTv, "profile:update", { id: child.id, kid: true });
assert.deepEqual(r.res, { id: child.id, name: "Kid", color: COLORS[3], kid: true });
assert.equal(kidTv.data.profile.kid, true);
assert.deepEqual(t.last(kidTv, "profiles").current, { id: child.id, name: "Kid", color: COLORS[3], kid: true });
assert.deepEqual(t.last(kidTv, "profiles").list.map((p) => [p.name, p.kid]), [["Alice", false], ["Kid", true]]);
// later announcements keep it too (the gate doesn't rebuild the profile field by field)
await t.send(tv, "profile:create", { name: "Guest" });
assert.deepEqual([kidTv.data.profile.kid, aliceTv.data.profile.kid], [true, false]);
assert.equal(t.last(kidTv, "profiles").current.kid, true);

// what each refused event would do for whoever sends it (its own ids)
const guest = () => t.mem.profiles.find((p) => p.name === "Guest");
const ARGS = {
  "video:add": () => [{ url: "https://youtu.be/nnnnnnnnnnn" }],
  "video:remove": () => [v2.id],
  "video:category": (who) => [{ id: v1.id, category: own[who].cat }],
  "video:retry": () => [failed.id],
  "channel:download": () => [{ channel: c1.id, videos: [{ ytId: "ddddddddddd" }], shorts: false }],
  "channel:follow": () => [{ id: c1.id, follow: true }],
  "channel:stop": () => [c1.id],
  "channel:refresh": () => [c1.id],
  "category:add": () => ["New"],
  "category:remove": (who) => [own[who].cat],
  "settings:save": () => [{ quality: 720, deleteWatchedDays: 30, keepPerChannel: 10 }],
  "storage:cleanup": () => [],
  "profile:create": () => [{ name: "Another" }],
  "profile:update": (who) => [{ id: who, color: COLORS[4], kid: false }],
  "profile:delete": (who) => [{ id: who === grown.id ? guest().id : who }],
  "profile:claim": (who) => [{ profile: who, expect: 0, categories: false }],
  "playlist:browse": () => [{ url: "https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  "playlist:download": () => [{ list: "PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", videos: ["ppppppppppp"] }],
};
const refused = Object.keys(KIDS).filter((name) => !kidMay(name));
assert.deepEqual(refused.filter((name) => !ARGS[name]), [], "every refused event is tried");
assert.ok(refused.length >= 18, refused.join(" "));

// a kids profile: every one of them answers KIDS_ERRORS.kid, and nothing is written, downloaded or read from YouTube
for (const name of refused) {
  const before = t.state();
  r = await t.send(kidTv, name, ...ARGS[name](child.id));
  assert.deepEqual([r.res, r.passed], [{ error: KIDS_ERRORS.kid }, false], name);
  assert.equal(t.state(), before, `${name} wrote something`);
}
// sent without an answer asked for: dropped all the same
let ranBefore = t.state();
await kidTv.middleware(["video:remove", v1.id], () => assert.fail("passed on"));
await settle();
assert.equal(t.state(), ranBefore);
// a TV that connects as the kids profile afterwards is refused too
const kidPhone = await t.connect({ profile: child.id });
assert.equal(kidPhone.data.profile.kid, true);
r = await t.send(kidPhone, "video:add", { url: "https://youtu.be/nnnnnnnnnnn" });
assert.deepEqual([r.res, r.passed], [{ error: KIDS_ERRORS.kid }, false]);

// what a kids profile may do: watch, and keep its place
const allowed = Object.keys(KIDS).filter(kidMay);
assert.deepEqual(allowed.sort(), ["channel:browse", "dupes", "library", "parent:lock", "parent:unlock", "profile:list", "settings", "storage", "video:position", "video:watched"]);
const kidLib = (await t.send(kidTv, "library")).res;
assert.deepEqual([kidLib.videos.map((v) => v.id).sort(), kidLib.profile.kid], [[v1.id, v2.id, failed.id].sort(), true]);
for (const name of ["settings", "storage", "channel:browse"]) assert.equal((await t.send(kidTv, name, ...(name === "channel:browse" ? [{ id: c1.id, tab: "videos" }] : []))).passed, true, name);
assert.equal((await t.send(kidTv, "dupes")).res.total, 0);
assert.deepEqual((await t.send(kidTv, "profile:list")).res.profiles.map((p) => [p.name, p.kid]), [["Alice", false], ["Kid", true], ["Guest", false]]);
assert.equal((await t.send(kidTv, "video:position", { id: v1.id, position: 61.6 })).passed, true);
assert.equal((await t.store.links(child.id)).find((l) => l.video === v1.id).position, 62);
assert.equal((await t.send(kidTv, "video:watched", v1.id)).passed, true);
assert.ok((await t.store.links(child.id)).find((l) => l.video === v1.id).watchedAt > 0);
let positioned = false;
await kidTv.middleware(["video:position", { id: v1.id, position: 70 }], () => (positioned = true));
assert.equal(positioned, true);

// a grown-up's profile: the same events go on as before
const check = {
  "video:add": (res) => t.db.videos.some((v) => v.ytId === "nnnnnnnnnnn" && res.id === v.id),
  "video:remove": () => !t.mem.links.some((l) => l.profile === grown.id && l.video === v2.id),
  "video:category": () => t.mem.links.find((l) => l.profile === grown.id && l.video === v1.id).category === own[grown.id].cat,
  "video:retry": (res, passed) => passed && failed.status === "queued",
  "channel:download": (res) => t.db.videos.some((v) => v.ytId === "ddddddddddd" && res.ids.includes(v.id)),
  "channel:follow": () => t.mem.follows.some((f) => f.profile === grown.id && f.channel === c1.id) && c1.follow,
  "channel:stop": (res) => typeof res.removed === "number",
  "channel:refresh": (res, passed) => passed && c1.refreshed === 1,
  "category:add": (res) => t.mem.cats.some((c) => c.id === res.id && c.profile === grown.id),
  "category:remove": () => !t.mem.cats.some((c) => c.id === own[grown.id].cat),
  "settings:save": (res, passed) => passed && t.db.settings.quality === 720 && t.db.settings.deleteWatchedDays === 0,
  "storage:cleanup": (res, passed) => passed && res.removed === 0,
  "profile:create": (res) => res.name === "Another" && res.kid === false,
  "profile:update": (res) => res.color === COLORS[4] && res.kid === false,
  "profile:delete": () => !guest(),
  "profile:claim": (res) => res.moved === 0,
  "playlist:browse": (res, passed) => passed && Array.isArray(res.videos),
  "playlist:download": (res, passed) => passed && res.queued === 1,
};
assert.deepEqual(refused.filter((name) => !check[name]), []);
for (const name of refused) {
  r = await t.send(aliceTv, name, ...ARGS[name](grown.id));
  assert.notDeepEqual(r.res, { error: KIDS_ERRORS.kid }, name);
  assert.ok(check[name](r.res, r.passed), `${name}: ${JSON.stringify(r.res)}`);
}

// a connection that hasn't picked a profile is as without kids profiles (no password)
assert.deepEqual((await t.send(tv, "video:add", { url: "https://youtu.be/nnnnnnnnnnn" })).res, { error: ERRORS.pick });

// unmarked, the same TV adds again
r = await t.send(aliceTv, "profile:update", { id: child.id, kid: false });
assert.equal(r.res.kid, false);
assert.equal(kidTv.data.profile.kid, false);
r = await t.send(kidTv, "video:add", { url: "https://youtu.be/kkkkkkkkkkk" });
assert.equal(r.passed, true);
assert.ok(await t.store.isMember(child.id, r.res.id));

// ---- the last grown-up ----
await t.send(tv, "profile:update", { id: child.id, kid: true });
for (const p of t.mem.profiles.filter((p) => p.id !== grown.id && p.id !== child.id)) await t.send(tv, "profile:delete", { id: p.id });
assert.deepEqual(t.mem.profiles.map((p) => [p.name, !!p.kid]), [["Alice", false], ["Kid", true]]);
let before = t.state();
// neither marked nor deleted, by anyone, and nothing written
for (const socket of [tv, aliceTv]) {
  assert.deepEqual((await t.send(socket, "profile:update", { id: grown.id, kid: true })).res, { error: KIDS_ERRORS.lastGrownUp });
  assert.deepEqual((await t.send(socket, "profile:delete", { id: grown.id })).res, { error: KIDS_ERRORS.lastGrownUp });
}
assert.equal(t.state(), before);
// the kids profile can't take its own mark off; a connection without a profile, or a grown-up, can
assert.deepEqual((await t.send(kidTv, "profile:update", { id: child.id, kid: false })).res, { error: KIDS_ERRORS.kid });
assert.equal((await t.send(tv, "profile:update", { id: child.id, kid: false })).res.kid, false);
assert.equal((await t.send(aliceTv, "profile:update", { id: child.id, kid: true })).res.kid, true);
// with another grown-up the first one can be marked; two marked at once can't both get through
const bob = (await t.send(tv, "profile:create", { name: "Bob" })).res;
const both = await Promise.all([t.send(tv, "profile:update", { id: grown.id, kid: true }), t.send(tv, "profile:update", { id: bob.id, kid: true })]);
assert.deepEqual(both.map((x) => x.res.error || x.res.kid).sort(), [KIDS_ERRORS.lastGrownUp, true].sort());
assert.equal(t.mem.profiles.filter((p) => !p.kid).length, 1);
const left = t.mem.profiles.find((p) => !p.kid);
assert.deepEqual((await t.send(tv, "profile:delete", { id: left.id })).res, { error: KIDS_ERRORS.lastGrownUp });
// kids profiles can go; the only profile left can't be marked, but can go (the next one starts over)
for (const p of t.mem.profiles.filter((p) => p.kid)) assert.equal((await t.send(tv, "profile:delete", { id: p.id })).res.error, undefined);
assert.deepEqual((await t.send(tv, "profile:update", { id: left.id, kid: true })).res, { error: KIDS_ERRORS.lastGrownUp });
assert.equal((await t.send(tv, "profile:delete", { id: left.id })).res.error, undefined);
assert.deepEqual(t.mem.profiles, []);
assert.deepEqual(t.errors, []);

// ==================== HOMETUBE_KIDS off ====================
const off = setup({ kids: false });
const c9 = off.addChannel();
off.addVideo("aaaaaaaaaaa", c9);
const offTv = await off.connect();
const anne = (await off.send(offTv, "profile:create", { name: "Anne" })).res;
const ben = (await off.send(offTv, "profile:create", { name: "Ben" })).res;
// a profile marked while the flag was on (still in the database) is an ordinary profile now
off.mem.profiles.find((p) => p.id === ben.id).kid = true;
const benTv = await off.connect({ profile: ben.id });
// kid is never sent: not in profiles, the library, profile:list or an update's answer
assert.deepEqual(benTv.data.profile, { id: ben.id, name: "Ben", color: ben.color });
assert.equal(JSON.stringify(benTv.got).includes("kid"), false);
assert.equal(JSON.stringify((await off.send(benTv, "library")).res).includes("kid"), false);
assert.equal(JSON.stringify((await off.send(offTv, "profile:list")).res).includes("kid"), false);
// nothing is refused
r = await off.send(benTv, "video:add", { url: "https://youtu.be/nnnnnnnnnnn" });
assert.equal(r.passed, true);
assert.equal((await off.send(benTv, "category:add", "Mine")).res.error, undefined);
// profile:update { kid } is ignored: not written, not answered
r = await off.send(offTv, "profile:update", { id: anne.id, kid: true });
assert.deepEqual(r.res, { id: anne.id, name: "Anne", color: anne.color });
r = await off.send(offTv, "profile:update", { id: ben.id, kid: false, name: "Benny" });
assert.deepEqual(r.res, { id: ben.id, name: "Benny", color: ben.color });
assert.deepEqual(off.updates.map((u) => "kid" in u), [false, false]);
assert.equal(off.mem.profiles.find((p) => p.id === anne.id).kid, undefined);
assert.equal(off.mem.profiles.find((p) => p.id === ben.id).kid, true);
assert.equal(JSON.stringify(offTv.got).includes("kid"), false);
// and no last grown-up rule: the one profile that isn't marked can go
assert.equal((await off.send(offTv, "profile:delete", { id: anne.id })).res.error, undefined);
assert.deepEqual(off.errors, []);

console.log(`kids profiles ok (${refused.length} refused, ${allowed.length} allowed of ${Object.keys(ROUTES).length} events)`);
