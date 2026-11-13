import assert from "node:assert/strict";
import * as rules from "./profileRules.js";
import { createGate } from "./profileGate.js";

// The parent lock (HOMETUBE_KIDS=1) through the gate, with the database, socket.io and the library's
// handlers faked and the clock in the test's hands: a grown-up opens a kids profile's connection for
// 15 minutes, everything a kids profile is refused then goes through but deleting a profile and
// marking one, it shuts on time, on parent:lock and when the profile is marked, and without the flag
// none of it exists. Each check starts from its own world and they all run, so a broken gate shows
// every check it breaks.

const { ROUTES, KIDS, KIDS_ERRORS, ERRORS, COLORS, kidMay, profileWire } = rules;
const MINUTES_15 = 15 * 60 * 1000;
const KIDS_ONLY = "Only a kids profile has a parent lock.";
const T0 = 1_800_000_000_000;

let next = 0;
const newId = () => (++next).toString(16).padStart(24, "0");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function setup({ kids }) {
  // ---- the clock the gate reads ----
  const clock = { now: T0 };
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
  const find = (id) => mem.profiles.find((p) => p.id === id);
  const store = {
    profiles: async () => mem.profiles.map(wire),
    profileById: async (id) => (find(id) ? wire(find(id)) : null),
    profileByKey: async (key) => (key && mem.profiles.find((p) => p.nameKey === key) ? wire(mem.profiles.find((p) => p.nameKey === key)) : null),
    createProfile: async (fields) => {
      const p = { id: newId(), ...fields };
      mem.profiles.push(p);
      return wire(p);
    },
    updateProfile: async (id, fields) => {
      updates.push({ id, ...fields });
      Object.assign(find(id), fields);
      return wire(find(id));
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
  const gate = createGate({ store, io, upstream, log, kids, clock: () => clock.now });
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
  // { res, passed }: passed when the library's own handler ran; res is "no answer" when none came
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
  return { clock, db, mem, ran, updates, errors, store, gate, addChannel, addVideo, connect, send, state, last };
}

// A home with kids profiles on: a grown-up (Alice) and a kids profile (Kid), each with the same three
// videos and a category of its own, watched on a TV each.
async function world() {
  const t = setup({ kids: true });
  const c1 = t.addChannel();
  const v1 = t.addVideo("aaaaaaaaaaa", c1);
  const v2 = t.addVideo("bbbbbbbbbbb", c1);
  const failed = t.addVideo("fffffffffff", c1, { status: "failed" });
  const tv = await t.connect();
  const grown = (await t.send(tv, "profile:create", { name: "Alice" })).res;
  const child = (await t.send(tv, "profile:create", { name: "Kid", color: COLORS[3] })).res;
  for (const p of [grown, child]) await t.store.link(p.id, [v1.id, v2.id, failed.id]);
  await t.send(tv, "profile:update", { id: child.id, kid: true });
  const aliceTv = await t.connect({ profile: grown.id });
  const kidTv = await t.connect({ profile: child.id });
  const cat = await t.store.addCategory(child.id, "Cartoons");
  return { t, c1, v1, v2, failed, tv, grown, child, aliceTv, kidTv, cat };
}

const unlock = (t, socket, data = {}) => t.send(socket, "parent:unlock", data);
const refusedNames = () => Object.keys(KIDS).filter((name) => !kidMay(name));
// the two that stay refused with the parent lock open
const KEPT = ["profile:delete", "profile:update"];

// what each refused event does when the kids profile's own connection sends it (its own ids), and how to tell it did
function attempts(w) {
  const { t, c1, v1, v2, failed, child, cat } = w;
  const kid = child.id;
  return {
    "video:add": [[{ url: "https://youtu.be/nnnnnnnnnnn" }], (res) => t.db.videos.some((v) => v.ytId === "nnnnnnnnnnn" && res.id === v.id) && t.mem.links.some((l) => l.profile === kid && l.video === res.id)],
    "video:remove": [[v2.id], () => !t.mem.links.some((l) => l.profile === kid && l.video === v2.id)],
    "video:category": [[{ id: v1.id, category: cat }], () => t.mem.links.find((l) => l.profile === kid && l.video === v1.id).category === cat],
    "video:retry": [[failed.id], (res, passed) => passed && failed.status === "queued"],
    "channel:download": [[{ channel: c1.id, videos: [{ ytId: "ddddddddddd" }], shorts: false }], (res) => t.db.videos.some((v) => v.ytId === "ddddddddddd" && res.ids.includes(v.id))],
    "channel:follow": [[{ id: c1.id, follow: true }], () => t.mem.follows.some((f) => f.profile === kid && f.channel === c1.id) && c1.follow],
    "channel:stop": [[c1.id], (res) => typeof res.removed === "number"],
    "channel:refresh": [[c1.id], (res, passed) => passed && c1.refreshed === 1],
    "category:add": [["New"], (res) => t.mem.cats.some((c) => c.id === res.id && c.profile === kid)],
    "category:remove": [[cat], () => !t.mem.cats.some((c) => c.id === cat)],
    "settings:save": [[{ quality: 720, deleteWatchedDays: 30, keepPerChannel: 10 }], (res, passed) => passed && t.db.settings.quality === 720 && t.db.settings.deleteWatchedDays === 0],
    "storage:cleanup": [[], (res, passed) => passed && res.removed === 0],
    "profile:create": [[{ name: "Another" }], (res) => res.name === "Another" && res.kid === false],
    // a name or a color: opened; the kids mark stays out of reach (see KEPT)
    "profile:update": [[{ id: kid, name: "Kiddo", color: COLORS[4] }], (res) => res.name === "Kiddo" && res.color === COLORS[4] && res.kid === true],
    "profile:delete": [[{ id: kid }], () => !t.mem.profiles.some((p) => p.id === kid)],
    "profile:claim": [[{ profile: kid, expect: 0, categories: false }], (res) => res.moved === 0],
    "playlist:browse": [[{ url: "https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], (res, passed) => passed && Array.isArray(res.videos)],
    "playlist:download": [[{ list: "PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", videos: ["ppppppppppp"] }], (res, passed) => passed && res.queued === 1],
  };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, assertion: err instanceof assert.AssertionError, message: String(err.message).split("\n")[0] });
  }
}

// ==================== HOMETUBE_KIDS on ====================
await check("the two events are decided: routed to the gate and allowed for a kids profile", () => {
  for (const name of ["parent:unlock", "parent:lock"]) {
    assert.equal(ROUTES[name], "self", name);
    assert.equal(KIDS[name], "allow", name);
  }
  assert.deepEqual(Object.keys(ROUTES).filter((name) => !["allow", "refuse"].includes(KIDS[name])), []);
  assert.deepEqual([...(rules.PARENT_EVENTS || [])].sort(), ["parent:lock", "parent:unlock"]);
  assert.equal(rules.PARENT_MS, MINUTES_15);
  assert.deepEqual(rules.PARENT_ERRORS, { kidsOnly: KIDS_ONLY });
});

await check("parentMay keeps deleting a profile and marking one; parentFor caps and checks left", () => {
  assert.equal(typeof rules.parentMay, "function");
  for (const name of refusedNames().filter((n) => !KEPT.includes(n))) assert.equal(rules.parentMay(name, {}), true, name);
  assert.equal(rules.parentMay("profile:delete", { id: "x" }), false);
  assert.equal(rules.parentMay("profile:update", { id: "x", kid: false }), false);
  assert.equal(rules.parentMay("profile:update", { id: "x", kid: true, name: "N" }), false);
  assert.equal(rules.parentMay("profile:update", { id: "x", kid: null }), false);
  assert.equal(rules.parentMay("profile:update", { id: "x", name: "N", color: 200 }), true);
  assert.equal(rules.parentMay("profile:update", undefined), true);
  assert.equal(typeof rules.parentFor, "function");
  assert.equal(rules.parentFor({}), MINUTES_15);
  assert.equal(rules.parentFor(undefined), MINUTES_15);
  assert.equal(rules.parentFor({ resume: true, left: 2000 }), 2000);
  assert.equal(rules.parentFor({ resume: true, left: 99 * 60 * 1000 }), MINUTES_15);
  for (const left of ["2000", 0, -5, Number.NaN, null, undefined, {}]) assert.equal(rules.parentFor({ resume: true, left }), 0, String(left));
});

await check("profiles says the parent lock is there, on connecting and on every announcement", async () => {
  const w = await world();
  assert.equal(w.t.last(w.kidTv, "profiles").parentLock, true);
  assert.equal(w.t.last(w.aliceTv, "profiles").parentLock, true);
  await w.t.send(w.tv, "profile:create", { name: "Guest" });
  assert.equal(w.t.last(w.kidTv, "profiles").parentLock, true);
  assert.equal(w.t.last(w.tv, "profiles").parentLock, true);
});

await check("locked, a kids profile is refused all 18 and nothing is written", async () => {
  const w = await world();
  const tries = attempts(w);
  const refused = refusedNames();
  assert.equal(refused.length, 18);
  for (const name of refused) {
    const before = w.t.state();
    const r = await w.t.send(w.kidTv, name, ...tries[name][0]);
    assert.deepEqual([r.res, r.passed], [{ error: KIDS_ERRORS.kid }, false], name);
    assert.equal(w.t.state(), before, `${name} wrote something`);
  }
});

await check("parent:unlock opens a kids profile's connection for 15 minutes and answers until", async () => {
  const w = await world();
  const r = await unlock(w.t, w.kidTv);
  assert.deepEqual(r.res, { until: T0 + MINUTES_15 });
  assert.equal(r.passed, false);
  assert.equal(w.kidTv.data.parentUntil, T0 + MINUTES_15);
  assert.equal((await w.t.send(w.kidTv, "category:add", "Shows")).res.error, undefined);
});

await check("parent:unlock is a kids profile's only: a grown-up's answers an error, no profile is told to pick one", async () => {
  const w = await world();
  const before = w.t.state();
  assert.deepEqual((await unlock(w.t, w.aliceTv)).res, { error: KIDS_ONLY });
  assert.equal(w.aliceTv.data.parentUntil, undefined);
  assert.deepEqual((await unlock(w.t, w.tv)).res, { error: ERRORS.pick });
  assert.deepEqual((await w.t.send(w.tv, "parent:lock", {})).res, { error: ERRORS.pick });
  assert.equal(w.t.state(), before);
  assert.deepEqual(w.t.errors, []);
});

await check("unlocked, the refused events go through as for a grown-up, but deleting a profile and marking one", async () => {
  const w = await world();
  await unlock(w.t, w.kidTv);
  const tries = attempts(w);
  const open = refusedNames().filter((name) => !KEPT.includes(name) || name === "profile:update");
  assert.equal(open.length, 17);
  for (const name of open) {
    const [args, did] = tries[name];
    const r = await w.t.send(w.kidTv, name, ...args);
    assert.notDeepEqual(r.res, { error: KIDS_ERRORS.kid }, name);
    assert.ok(did(r.res, r.passed), `${name}: ${JSON.stringify(r.res)}`);
  }
  assert.deepEqual(w.t.errors, []);
});

await check("unlocked, profile:delete and profile:update with kid stay refused and write nothing", async () => {
  const w = await world();
  await unlock(w.t, w.kidTv);
  const before = w.t.state();
  const kept = [
    ["profile:delete", { id: w.child.id }],
    ["profile:delete", { id: w.grown.id }],
    ["profile:delete", w.child.id],
    ["profile:update", { id: w.child.id, kid: false }],
    ["profile:update", { id: w.child.id, kid: false, name: "Free" }],
    ["profile:update", { id: w.grown.id, kid: true }],
  ];
  for (const [name, data] of kept) {
    const r = await w.t.send(w.kidTv, name, data);
    assert.deepEqual([r.res, r.passed], [{ error: KIDS_ERRORS.kid }, false], `${name} ${JSON.stringify(data)}`);
  }
  assert.equal(w.t.state(), before);
  assert.equal(w.kidTv.data.profile.kid, true);
});

await check("the lock shuts on time: the clock is read on every event", async () => {
  const w = await world();
  await unlock(w.t, w.kidTv);
  w.t.clock.now = T0 + MINUTES_15 - 1;
  assert.equal((await w.t.send(w.kidTv, "category:add", "Last")).res.error, undefined);
  w.t.clock.now = T0 + MINUTES_15;
  const before = w.t.state();
  assert.deepEqual((await w.t.send(w.kidTv, "category:add", "Late")).res, { error: KIDS_ERRORS.kid });
  assert.deepEqual((await w.t.send(w.kidTv, "video:remove", w.v1.id)).res, { error: KIDS_ERRORS.kid });
  assert.equal(w.t.state(), before);
  // asking again opens it again, from now
  assert.deepEqual((await unlock(w.t, w.kidTv)).res, { until: T0 + 2 * MINUTES_15 });
});

await check("parent:lock shuts it at once and answers {}", async () => {
  const w = await world();
  await unlock(w.t, w.kidTv);
  assert.deepEqual((await w.t.send(w.kidTv, "parent:lock", {})).res, {});
  assert.equal(w.kidTv.data.parentUntil, 0);
  assert.deepEqual((await w.t.send(w.kidTv, "category:add", "After")).res, { error: KIDS_ERRORS.kid });
  // locking a grown-up's connection does nothing harmful
  assert.deepEqual((await w.t.send(w.aliceTv, "parent:lock", {})).res, {});
  assert.equal((await w.t.send(w.aliceTv, "category:add", "Mine")).res.error, undefined);
});

await check("resume opens for what the device had left, at most 15 minutes; a left that isn't above 0 opens nothing", async () => {
  const w = await world();
  // a TV that connects again while its lock was open
  const again = await w.t.connect({ profile: w.child.id });
  assert.deepEqual((await w.t.send(again, "category:add", "Before")).res, { error: KIDS_ERRORS.kid });
  assert.deepEqual((await unlock(w.t, again, { resume: true, left: 2000 })).res, { until: T0 + 2000 });
  assert.equal((await w.t.send(again, "category:add", "Now")).res.error, undefined);
  w.t.clock.now = T0 + 3000;
  assert.deepEqual((await w.t.send(again, "category:add", "Then")).res, { error: KIDS_ERRORS.kid });
  // never longer than 15 minutes
  assert.deepEqual((await unlock(w.t, again, { resume: true, left: 60 * 60 * 1000 })).res, { until: T0 + 3000 + MINUTES_15 });
  // left that isn't a number above 0: nothing opens
  const other = await w.t.connect({ profile: w.child.id });
  for (const left of ["5000", 0, -1, null, undefined]) {
    assert.deepEqual((await unlock(w.t, other, { resume: true, left })).res, { until: 0 }, String(left));
    assert.deepEqual((await w.t.send(other, "category:add", "No")).res, { error: KIDS_ERRORS.kid }, String(left));
  }
  // a grown-up's connection can't resume either
  assert.deepEqual((await unlock(w.t, w.aliceTv, { resume: true, left: 2000 })).res, { error: KIDS_ONLY });
});

await check("the lock is the connection's: another device on the same kids profile stays locked", async () => {
  const w = await world();
  const phone = await w.t.connect({ profile: w.child.id });
  await unlock(w.t, phone);
  assert.equal((await w.t.send(phone, "category:add", "Phone")).res.error, undefined);
  assert.deepEqual((await w.t.send(w.kidTv, "category:add", "Tv")).res, { error: KIDS_ERRORS.kid });
});

await check("marking the profile again shuts its open locks; another profile's mark leaves them open", async () => {
  const w = await world();
  const guest = (await w.t.send(w.tv, "profile:create", { name: "Guest" })).res;
  await unlock(w.t, w.kidTv);
  await w.t.send(w.aliceTv, "profile:update", { id: guest.id, kid: true });
  assert.equal(w.kidTv.data.parentUntil, T0 + MINUTES_15);
  assert.equal((await w.t.send(w.kidTv, "category:add", "Still")).res.error, undefined);
  // unmarked and marked again from a grown-up's profile: the TV starts locked
  assert.equal((await w.t.send(w.aliceTv, "profile:update", { id: w.child.id, kid: false })).res.kid, false);
  assert.equal(w.kidTv.data.parentUntil, 0);
  assert.equal((await w.t.send(w.aliceTv, "profile:update", { id: w.child.id, kid: true })).res.kid, true);
  assert.deepEqual((await w.t.send(w.kidTv, "category:add", "Locked")).res, { error: KIDS_ERRORS.kid });
});

// ==================== HOMETUBE_KIDS off ====================
await check("without the flag profiles has no parentLock and both events are as unknown as any other", async () => {
  const off = setup({ kids: false });
  off.addVideo("aaaaaaaaaaa", off.addChannel());
  const tv = await off.connect();
  const anne = (await off.send(tv, "profile:create", { name: "Anne" })).res;
  const anneTv = await off.connect({ profile: anne.id });
  assert.equal(JSON.stringify([tv.got, anneTv.got]).includes("parentLock"), false);
  const before = off.state();
  const stray = await off.send(anneTv, "video:stray", {});
  for (const name of ["parent:unlock", "parent:lock"]) {
    const r = await off.send(anneTv, name, {});
    assert.deepEqual(r, stray, name);
    assert.deepEqual(r, { res: "no answer", passed: false }, name);
    assert.deepEqual(await off.send(tv, name, {}), stray, name);
  }
  assert.equal(anneTv.data.parentUntil, undefined);
  assert.equal(off.state(), before);
  assert.deepEqual(off.errors, ["unrouted event video:stray", "unrouted event parent:unlock", "unrouted event parent:unlock", "unrouted event parent:lock", "unrouted event parent:lock"]);
});

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.error(`not ok - ${r.name}: ${r.assertion ? "AssertionError" : "Error"}: ${r.message}`);
if (failed.length) {
  console.error(`parent lock: ${failed.length} of ${results.length} checks failed (${failed.filter((r) => r.assertion).length} on an assertion)`);
  process.exit(1);
}
console.log(`parent lock ok (${results.length}/${results.length} checks)`);
