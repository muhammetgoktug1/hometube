import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as rules from "./profileRules.js";
import { createGate } from "./profileGate.js";

// Editing categories (HOMETUBE_CATEGORY_EDIT=1): category:rename and category:add's "there's one by that
// name already", through the gate with the database and socket.io faked (a profile's categories), and
// through lib/categories.js with the database faked (the library's own). The store records every call,
// so "nothing changed" means the store wasn't even asked. Each check starts from its own world and they
// all run, so a broken rule shows every check it breaks.

const { KIDS_ERRORS, COLORS } = rules;
// the messages, as clients get them (written out: the test reads what the server says, not its constants)
const NAME = "Give the category a name.";
const TAKEN = "There's already a category with this name.";
const GONE = "This category no longer exists.";

let next = 0;
const newId = () => (++next).toString(16).padStart(24, "0");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// lib/categories.js and lib/categoryRules.js, or nothing when they aren't there
const optional = (path) => import(path).catch(() => ({}));

function setup({ categoryEdit, kids = true }) {
  const clock = { now: 1_800_000_000_000 };
  const db = { videos: [], channels: [{ id: newId(), name: "Channel", follow: false }] };
  const library = async () => ({ videos: db.videos.map((v) => ({ ...v })), channels: db.channels.map((c) => ({ ...c })), categories: [] });
  const upstream = { library, removeVideo: async () => {}, followChannel: async () => ({}) };

  // ---- a profile's collections, in memory; calls: every call that writes ----
  const mem = { profiles: [], links: [], cats: [], follows: [] };
  const calls = [];
  const wire = (p) => rules.profileWire({ _id: p.id, ...p }, kids);
  const find = (id) => mem.profiles.find((p) => p.id === id);
  // what the store is asked to rename returns this, unless a test says otherwise (a category deleted meanwhile)
  const hooks = { renamed: null };
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
      Object.assign(find(id), fields);
      return wire(find(id));
    },
    videoCounts: async () => new Map(),
    orphanCount: async () => 0,
    links: async (profile) => mem.links.filter((l) => l.profile === profile).map((l) => ({ ...l })),
    follows: async (profile) => mem.follows.filter((f) => f.profile === profile).map((f) => f.channel),
    categories: async (profile) => mem.cats.filter((c) => c.profile === profile).map((c) => ({ id: c.id, name: c.name })),
    hasCategory: async (profile, id) => mem.cats.some((c) => c.profile === profile && c.id === id),
    addCategory: async (profile, name) => {
      calls.push(["addCategory", profile, name]);
      // a database answers later than at once: two requests interleave here as they would
      await settle();
      const c = { id: newId(), profile, name };
      mem.cats.push(c);
      return c.id;
    },
    renameCategory: async (profile, id, name) => {
      calls.push(["renameCategory", profile, id, name]);
      if (hooks.renamed !== null) return hooks.renamed;
      const c = mem.cats.find((x) => x.profile === profile && x.id === id);
      if (c) c.name = name;
      return !!c;
    },
    removeCategory: async (profile, id) => {
      calls.push(["removeCategory", profile, id]);
      mem.cats = mem.cats.filter((c) => !(c.profile === profile && c.id === id));
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
  const gate = createGate({ store, io, upstream, log, kids, clock: () => clock.now, categoryEdit });
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
  // { res, passed }: passed when the library's own handler would have run; res is "no answer" when none came
  async function send(socket, name, ...args) {
    let passed = false;
    const answered = new Promise((resolve) => {
      socket.middleware([name, ...args, (res) => resolve(res)], () => (passed = true));
    });
    const res = await Promise.race([answered, settle().then(settle).then(settle).then(() => "no answer")]);
    await settle();
    return { res, passed };
  }
  const state = () => JSON.stringify({ mem, calls });
  const libraries = (socket) => socket.got.filter(([n]) => n === "library").map(([, lib]) => lib);
  return { clock, mem, calls, hooks, warnings, errors, store, gate, connect, send, state, libraries };
}

// A home: Alice and Bob each with categories of their own (Bob's include a name Alice has), and a kids
// profile with one; a TV watching as each.
async function world({ categoryEdit = true, kids = true } = {}) {
  const t = setup({ categoryEdit, kids });
  const tv = await t.connect();
  const alice = (await t.send(tv, "profile:create", { name: "Alice" })).res;
  const bob = (await t.send(tv, "profile:create", { name: "Bob", color: COLORS[2] })).res;
  const child = (await t.send(tv, "profile:create", { name: "Kid", color: COLORS[3] })).res;
  if (kids) await t.send(tv, "profile:update", { id: child.id, kid: true });
  const cat = (profile, name) => {
    const c = { id: newId(), profile, name };
    t.mem.cats.push(c);
    return c.id;
  };
  const a = { music: cat(alice.id, "Music"), cartoons: cat(alice.id, "Cartoons"), review: cat(alice.id, "\u0130nceleme") };
  const b = { music: cat(bob.id, "Music"), news: cat(bob.id, "News") };
  const k = { tales: cat(child.id, "Tales") };
  const aliceTv = await t.connect({ profile: alice.id });
  const bobTv = await t.connect({ profile: bob.id });
  const kidTv = await t.connect({ profile: child.id });
  return { t, tv, alice, bob, child, a, b, k, aliceTv, bobTv, kidTv };
}
const nameOf = (t, id) => t.mem.cats.find((c) => c.id === id)?.name;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, assertion: err instanceof assert.AssertionError, message: String(err.message).split("\n")[0] });
  }
}

// ==================== a profile's categories (the gate), HOMETUBE_CATEGORY_EDIT on ====================
await check("rename: the profile's own category takes the name, answers { id, name }, and its TVs hear the new library", async () => {
  const w = await world();
  const before = w.t.libraries(w.aliceTv).length;
  const r = await w.t.send(w.aliceTv, "category:rename", { id: w.a.cartoons, name: "  Nature  " });
  assert.deepEqual(r, { res: { id: w.a.cartoons, name: "Nature" }, passed: false });
  assert.deepEqual(w.t.calls, [["renameCategory", w.alice.id, w.a.cartoons, "Nature"]]);
  assert.equal(nameOf(w.t, w.a.cartoons), "Nature");
  const sent = w.t.libraries(w.aliceTv);
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1).categories.find((c) => c.id === w.a.cartoons), { id: w.a.cartoons, name: "Nature" });
  // another profile's library isn't sent its categories
  assert.equal(JSON.stringify(w.t.libraries(w.bobTv)).includes("Nature"), false);
  // at most 40 characters, as category:add keeps them
  const long = await w.t.send(w.aliceTv, "category:rename", { id: w.a.music, name: "x".repeat(50) });
  assert.deepEqual(long.res, { id: w.a.music, name: "x".repeat(40) });
});

await check("rename: another profile's category, or one that isn't there, answers 'no longer exists' and the store isn't asked", async () => {
  const w = await world();
  const before = w.t.state();
  for (const id of [w.b.news, w.b.music, w.k.tales, newId(), "not an id", 42, undefined]) {
    const r = await w.t.send(w.aliceTv, "category:rename", { id, name: "Mine now" });
    assert.deepEqual(r.res, { error: GONE }, String(id));
  }
  assert.equal(w.t.state(), before);
  assert.deepEqual([nameOf(w.t, w.b.news), nameOf(w.t, w.b.music), nameOf(w.t, w.k.tales)], ["News", "Music", "Tales"]);
});

await check("rename: deleted while it was being renamed (the store didn't find it) answers 'no longer exists' and sends no library", async () => {
  const w = await world();
  w.t.hooks.renamed = false;
  const before = w.t.libraries(w.aliceTv).length;
  assert.deepEqual((await w.t.send(w.aliceTv, "category:rename", { id: w.a.music, name: "Songs" })).res, { error: GONE });
  assert.equal(w.t.libraries(w.aliceTv).length, before);
});

await check("rename: the name of another of the profile's categories is taken (case, spaces, a dotted or dotless i); its own in other case isn't", async () => {
  const w = await world();
  const before = w.t.state();
  for (const name of ["Music", "music", " MUSIC ", "inceleme", "INCELEME", "i\u0307nceleme"]) {
    assert.deepEqual((await w.t.send(w.aliceTv, "category:rename", { id: w.a.cartoons, name })).res, { error: TAKEN }, name);
  }
  assert.equal(w.t.state(), before);
  // its own name with other letters cased, and a name only another profile has, are fine
  assert.deepEqual((await w.t.send(w.aliceTv, "category:rename", { id: w.a.music, name: "MUSIC" })).res, { id: w.a.music, name: "MUSIC" });
  assert.deepEqual((await w.t.send(w.aliceTv, "category:rename", { id: w.a.cartoons, name: "News" })).res, { id: w.a.cartoons, name: "News" });
  assert.deepEqual((await w.t.send(w.bobTv, "category:rename", { id: w.b.news, name: "Cartoons" })).res, { id: w.b.news, name: "Cartoons" });
});

await check("rename: an empty name (spaces, none, not even an object) answers the library's message and changes nothing", async () => {
  const w = await world();
  const before = w.t.state();
  for (const data of [{ id: w.a.music, name: "" }, { id: w.a.music, name: "   " }, { id: w.a.music }, { id: w.a.music, name: null }, "Music", undefined]) {
    assert.deepEqual((await w.t.send(w.aliceTv, "category:rename", data)).res, { error: NAME }, JSON.stringify(data));
  }
  assert.equal(w.t.state(), before);
  assert.equal(nameOf(w.t, w.a.music), "Music");
});

await check("add: a name the profile has (any case, spaces, a dotted or dotless i) answers { id, existed: true }, makes nothing and sends no library", async () => {
  const w = await world();
  const before = w.t.state();
  const sent = w.t.libraries(w.aliceTv).length;
  for (const [name, id] of [["Music", w.a.music], ["  music ", w.a.music], ["CARTOONS", w.a.cartoons], ["inceleme", w.a.review], ["\u0130NCELEME", w.a.review]]) {
    assert.deepEqual((await w.t.send(w.aliceTv, "category:add", name)).res, { id, existed: true }, name);
  }
  assert.equal(w.t.state(), before);
  assert.equal(w.t.libraries(w.aliceTv).length, sent);
  // a name only another profile has makes the profile its own; an empty one is refused as before
  const r = await w.t.send(w.aliceTv, "category:add", "News");
  assert.equal(r.res.existed, undefined);
  assert.ok(w.t.mem.cats.some((c) => c.id === r.res.id && c.profile === w.alice.id && c.name === "News"));
  assert.deepEqual((await w.t.send(w.aliceTv, "category:add", "  ")).res, { error: NAME });
});

await check("add: the same new name sent twice at once (a double click) makes one category", async () => {
  const w = await world();
  const [one, two] = await Promise.all([w.t.send(w.aliceTv, "category:add", "Garden"), w.t.send(w.aliceTv, "category:add", "garden")]);
  assert.equal(w.t.mem.cats.filter((c) => c.profile === w.alice.id && c.name.toLowerCase() === "garden").length, 1);
  assert.deepEqual([one.res.existed, two.res], [undefined, { id: one.res.id, existed: true }]);
  assert.equal(w.t.calls.filter(([n]) => n === "addCategory").length, 1);
});

await check("kids: a kids profile is refused category:rename and category:add with the kids message, and nothing is written", async () => {
  const w = await world();
  assert.equal(rules.ROUTES["category:rename"], "take");
  assert.equal(rules.KIDS["category:rename"], "refuse");
  const before = w.t.state();
  for (const [name, data] of [["category:rename", { id: w.k.tales, name: "Stories" }], ["category:add", "Stories"], ["category:add", "Tales"]]) {
    const r = await w.t.send(w.kidTv, name, data);
    assert.deepEqual(r, { res: { error: KIDS_ERRORS.kid }, passed: false }, name);
  }
  assert.equal(w.t.state(), before);
});

await check("kids: with the parent lock open the kids profile renames its own category, and the lock shuts it again", async () => {
  const w = await world();
  assert.ok((await w.t.send(w.kidTv, "parent:unlock", {})).res.until > 0);
  assert.deepEqual((await w.t.send(w.kidTv, "category:rename", { id: w.k.tales, name: "Stories" })).res, { id: w.k.tales, name: "Stories" });
  assert.deepEqual((await w.t.send(w.kidTv, "category:add", "stories")).res, { id: w.k.tales, existed: true });
  assert.equal(rules.parentMay("category:rename", { id: w.k.tales, name: "x" }), true);
  await w.t.send(w.kidTv, "parent:lock", {});
  assert.deepEqual((await w.t.send(w.kidTv, "category:rename", { id: w.k.tales, name: "Later" })).res, { error: KIDS_ERRORS.kid });
  assert.equal(nameOf(w.t, w.k.tales), "Stories");
});

// ==================== HOMETUBE_CATEGORY_EDIT off: as before ====================
await check("off: category:rename is as unknown as any other event, kids profiles on or off", async () => {
  for (const kids of [true, false]) {
    const w = await world({ categoryEdit: false, kids });
    const before = w.t.state();
    const stray = await w.t.send(w.aliceTv, "category:stray", { id: w.a.music, name: "x" });
    const r = await w.t.send(w.aliceTv, "category:rename", { id: w.a.music, name: "Songs" });
    assert.deepEqual(r, stray, `kids ${kids}`);
    assert.deepEqual(r, { res: "no answer", passed: false }, `kids ${kids}`);
    // a kids profile isn't told it's refused either: the event isn't there at all
    if (kids) assert.deepEqual(await w.t.send(w.kidTv, "category:rename", { id: w.k.tales, name: "x" }), stray);
    assert.equal(w.t.state(), before);
    assert.deepEqual(w.t.warnings, ["unrouted event category:stray", "unrouted event category:rename", ...(kids ? ["unrouted event category:rename"] : [])]);
  }
});

await check("off: category:add makes a second category with a name the profile has, as before", async () => {
  const w = await world({ categoryEdit: false });
  const r = await w.t.send(w.aliceTv, "category:add", "Music");
  assert.equal(r.res.existed, undefined);
  assert.notEqual(r.res.id, w.a.music);
  assert.deepEqual(w.t.mem.cats.filter((c) => c.profile === w.alice.id && c.name === "Music").length, 2);
});

// ==================== the library's own categories (lib/categories.js) ====================
const fakeDb = (names) => {
  const cats = names.map((name) => ({ id: newId(), name }));
  const calls = [];
  return {
    cats,
    calls,
    gone: false,
    list: async () => (calls.push(["list"]), cats.map((c) => ({ ...c }))),
    async rename(id, name) {
      calls.push(["rename", id, name]);
      const c = !this.gone && cats.find((x) => x.id === id);
      if (c) c.name = name;
      return !!c;
    },
  };
};

await check("library: rename renames, keeps the rules (empty, taken, gone) and asks the database only for a name it may take", async () => {
  const { createCategoryEdit } = await optional("./categories.js");
  assert.equal(typeof createCategoryEdit, "function");
  const fake = fakeDb(["Music", "Cartoons", "\u0130nceleme"]);
  const [music, cartoons, review] = fake.cats.map((c) => c.id);
  const edit = createCategoryEdit(fake);
  assert.deepEqual(await edit.rename({ id: cartoons, name: " Nature " }), { id: cartoons, name: "Nature" });
  assert.deepEqual(await edit.rename({ id: cartoons, name: "music" }), { error: TAKEN });
  assert.deepEqual(await edit.rename({ id: cartoons, name: "INCELEME" }), { error: TAKEN });
  assert.deepEqual(await edit.rename({ id: cartoons, name: "" }), { error: NAME });
  assert.deepEqual(await edit.rename({ id: newId(), name: "Other" }), { error: GONE });
  assert.deepEqual(await edit.rename(undefined), { error: NAME });
  assert.deepEqual(await edit.rename({ id: review, name: "inceleme" }), { id: review, name: "inceleme" });
  assert.deepEqual(fake.calls.filter(([n]) => n === "rename"), [["rename", cartoons, "Nature"], ["rename", review, "inceleme"]]);
  // deleted meanwhile
  fake.gone = true;
  assert.deepEqual(await edit.rename({ id: music, name: "Songs" }), { error: GONE });
  assert.deepEqual(fake.cats.map((c) => c.name), ["Music", "Nature", "inceleme"]);
});

await check("library: category:add's check finds a name the library has (case, spaces, a dotted or dotless i), and only that", async () => {
  const { createCategoryEdit } = await optional("./categories.js");
  assert.equal(typeof createCategoryEdit, "function");
  const fake = fakeDb(["Music", "\u00c7izgi film", "\u0130nceleme"]);
  const edit = createCategoryEdit(fake);
  assert.deepEqual(await edit.existing(" music "), { id: fake.cats[0].id, existed: true });
  assert.deepEqual(await edit.existing("\u00e7izgi   F\u0130LM"), { id: fake.cats[1].id, existed: true });
  assert.deepEqual(await edit.existing("inceleme"), { id: fake.cats[2].id, existed: true });
  for (const name of ["Musik", "\u00c7izgi", "Garden", ""]) assert.equal(await edit.existing(name), null, name);
  // a database that fails: as without the feature (a new category), the failure logged
  const logged = [];
  const broken = createCategoryEdit({ list: async () => Promise.reject(new Error("down")), rename: async () => false }, { error: (...m) => logged.push(m.join(" ")) });
  assert.equal(await broken.existing("Music"), null);
  assert.deepEqual(logged, ["category check failed down"]);
});

await check("library: every connection hears categories:edit; category:rename answers and the library goes out only when it worked", async () => {
  const mod = await optional("./categories.js");
  assert.equal(typeof mod.wireCategoryEdit, "function");
  const fake = fakeDb(["Music", "Cartoons"]);
  const listeners = {};
  const sent = [];
  let connections = 0;
  const io = { on: (name, fn) => (assert.equal(name, "connection"), connections++, fn({ on: (e, h) => (listeners[e] = h), emit: (...a) => sent.push(a) })) };
  let changed = 0;
  mod.wireCategoryEdit(io, Promise.resolve(mod.createCategoryEdit(fake)), { changed: async () => changed++ });
  assert.deepEqual([connections, Object.keys(listeners), sent], [1, ["category:rename"], [["categories:edit"]]]);
  const answers = [];
  await listeners["category:rename"]({ id: fake.cats[1].id, name: "Nature" }, (res) => answers.push(res));
  await listeners["category:rename"]({ id: fake.cats[1].id, name: "MUSIC" }, (res) => answers.push(res));
  // sent without an answer asked for: done all the same
  await listeners["category:rename"]({ id: fake.cats[0].id, name: "Songs" });
  assert.deepEqual(answers, [{ id: fake.cats[1].id, name: "Nature" }, { error: TAKEN }]);
  assert.equal(changed, 2);
  assert.deepEqual(fake.cats.map((c) => c.name), ["Songs", "Nature"]);
});

await check("library: without the flag nothing listens, nothing is said or logged, and category:add's check never looks", async () => {
  const flags = [[undefined, "unset"], ["0", "zero"], ["", "empty"], ["no", "word"]];
  for (const [flag, tag] of flags) {
    if (flag === undefined) delete process.env.HOMETUBE_CATEGORY_EDIT;
    else process.env.HOMETUBE_CATEGORY_EDIT = flag;
    const mod = await optional(`./categories.js?${tag}`);
    assert.equal(mod.ON, false, String(flag));
    const io = { handlers: 0, on: () => io.handlers++ };
    const logged = [];
    const keep = console.log;
    console.log = (...m) => logged.push(m.join(" "));
    let check;
    try {
      check = mod.startCategoryEdit(io, { changed: () => assert.fail("changed") });
    } finally {
      console.log = keep;
    }
    assert.deepEqual([io.handlers, logged], [0, []], String(flag));
    assert.equal(await check.existing("Music"), null);
  }
  process.env.HOMETUBE_CATEGORY_EDIT = "1";
  assert.equal((await optional("./categories.js?on")).ON, true);
  delete process.env.HOMETUBE_CATEGORY_EDIT;
});

// ==================== the shared rules and the dictionary ====================
await check("names: case, spaces and a dotted or dotless i make no other category; letters with marks do", async () => {
  const { categoryKey, sameName } = await optional("./categoryRules.js");
  assert.equal(typeof categoryKey, "function");
  const same = [["\u0130nceleme", "inceleme"], ["INCELEME", "inceleme"], ["I\u015f\u0131k", "\u0131\u015f\u0131k"], ["ILIK", "\u0131l\u0131k"], ["\u00c7izgi  film", " \u00e7izgi film "], ["M\u00dcZ\u0130K", "m\u00fczik"]];
  for (const [x, y] of same) assert.equal(categoryKey(x), categoryKey(y), `${x} ${y}`);
  for (const [x, y] of [["M\u00fczik", "Muzik"], ["\u00c7izgi film", "Cizgi film"], ["Music", "Musics"]]) assert.notEqual(categoryKey(x), categoryKey(y), `${x} ${y}`);
  // the same 40-character rule as category:add
  assert.equal(categoryKey("y".repeat(60)), "y".repeat(40));
  const list = [{ id: "a", name: "Music" }, { id: "b", name: "News" }];
  assert.deepEqual([sameName(list, "music")?.id, sameName(list, "music", "a"), sameName(list, "   ")], ["a", undefined, undefined]);
});

await check("the dictionary has every message category:rename answers", async () => {
  const { text } = JSON.parse(readFileSync(new URL("../src/i18n/tr.json", import.meta.url), "utf8"));
  for (const message of [NAME, TAKEN, GONE]) assert.ok(message in text, message);
  const { CATEGORY_ERRORS } = await optional("./categoryRules.js");
  assert.deepEqual(CATEGORY_ERRORS, { name: NAME, taken: TAKEN, gone: GONE });
});

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.error(`not ok - ${r.name}: ${r.assertion ? "AssertionError" : "Error"}: ${r.message}`);
if (failed.length) {
  console.error(`category editing: ${failed.length} of ${results.length} checks failed (${failed.filter((r) => r.assertion).length} on an assertion)`);
  process.exit(1);
}
console.log(`category editing ok (${results.length}/${results.length} checks)`);
