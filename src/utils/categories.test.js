import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as rules from "../../lib/categoryRules.js";
import * as profileRules from "../../lib/profileRules.js";
import { createGate } from "../../lib/profileGate.js";

// The category picker on the watch page (HOMETUBE_CATEGORY_EDIT): its rules next to the server's, and what it
// sends, through the server's own gate with the database and socket.io faked (a profile's categories and
// videos). The store records every call that writes, so "nothing changed" means the store wasn't asked. Every
// check runs, so a broken rule shows each check it breaks; categories.js missing fails them all.

const C = await import("./categories.js").catch(() => ({}));
const need = (name) => {
  assert.equal(typeof C[name], "function", `categories.js has no ${name}`);
  return C[name];
};

// the messages as clients get them (written out: the test reads what the server says)
const NAME = "Give the category a name.";
const TAKEN = "There's already a category with this name.";
const KID = profileRules.KIDS_ERRORS.kid;

// a profile's categories, in the library's order, with names a Turkish home would type
const CATS = [
  { id: "c1", name: "Belgesel" },
  { id: "c2", name: "Bilim" },
  { id: "c3", name: "\u00c7izgi film" },
  { id: "c4", name: "M\u00fczik" },
  { id: "c5", name: "\u0130nceleme" },
  { id: "c6", name: "Irmak" },
];
// names typed into the box: case, spaces, a dotted or dotless i, letters with and without their marks, a name
// in decomposed form, too long, empty, not a string
const TYPED = [
  "belgesel", "BELGESEL", "  Belgesel  ", "Bel  gesel", "bel", "gesel", "B\u0130L\u0130M", "bilim", "b\u0131l\u0131m",
  "\u00e7izgi film", "cizgi film", "\u00c7\u0130ZG\u0130   F\u0130LM", "C\u0327izgi film", "m\u00fczik", "muzik", "inceleme",
  "\u0130NCELEME", "i\u0307nceleme", "\u0131nceleme", "irmak", "\u0131rmak", "IRMAK", "Bah\u00e7e", "bahce", "x".repeat(50), "",
  "   ", null, undefined, 42,
];

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, assertion: err instanceof assert.AssertionError, message: String(err.message).split("\n")[0] });
  }
}

// ==================== the same rules as the server ====================
await check("the name rule, the same-name key and the messages are the server's", () => {
  const categoryKey = need("categoryKey");
  const categoryName = need("categoryName");
  for (const raw of TYPED) {
    assert.equal(categoryKey(raw), rules.categoryKey(raw), JSON.stringify(raw));
    assert.equal(categoryName(raw), profileRules.categoryName(raw), JSON.stringify(raw));
  }
  assert.equal(C.CATEGORY_MAX, profileRules.categoryName("y".repeat(99)).length);
  assert.deepEqual(C.CATEGORY_ERRORS, { name: rules.CATEGORY_ERRORS.name, taken: rules.CATEGORY_ERRORS.taken });
  // the picker turns on with the server's notice, heard where every page listens (AppShell's hook)
  const hook = readFileSync(new URL("../hooks/useCategoryEdit.js", import.meta.url), "utf8");
  assert.ok(hook.includes(`socket.on("${rules.NOTICE}"`), "the hook listens for the server's notice");
});

await check("'there's one by that name': the picker finds the category the server would answer for every typed name", () => {
  const pickerView = need("pickerView");
  for (const raw of TYPED) {
    if (!profileRules.categoryName(raw)) continue;
    assert.equal(pickerView(CATS, raw).exists?.id ?? null, rules.sameName(CATS, raw)?.id ?? null, JSON.stringify(raw));
  }
});

await check("a rename is refused before it's sent for exactly what the server refuses it for (its own category)", () => {
  const renameError = need("renameError");
  for (const { id } of CATS) {
    for (const raw of TYPED) {
      const plan = rules.renamePlan(CATS, { id, name: raw });
      assert.equal(renameError(CATS, id, raw), plan.error ?? null, `${id} ${JSON.stringify(raw)}`);
    }
  }
});

// ==================== what the box shows ====================
await check("filtering: an empty box lists every category in order; typed text keeps the ones whose name holds it", () => {
  const pickerView = need("pickerView");
  const names = (q) => pickerView(CATS, q).rows.map((c) => c.name);
  assert.deepEqual(pickerView(CATS, "").rows, CATS);
  assert.deepEqual(pickerView(CATS, "   ").rows, CATS);
  assert.deepEqual(names("bel"), ["Belgesel"]);
  assert.deepEqual(names(" BEL "), ["Belgesel"]);
  assert.deepEqual(names("i"), ["Bilim", "\u00c7izgi film", "M\u00fczik", "\u0130nceleme", "Irmak"]);
  assert.deepEqual(names("\u0131"), names("i"));
  assert.deepEqual(names("cizgi"), [], "c and \u00e7 are different letters");
  assert.deepEqual(names("\u00e7izgi  "), ["\u00c7izgi film"]);
  assert.deepEqual(names("bah\u00e7e"), []);
});

await check("'create “X” and add': only while the typed name isn't a category; the name trimmed and at most 40 characters", () => {
  const pickerView = need("pickerView");
  assert.deepEqual(pickerView(CATS, "Bah\u00e7e"), { rows: [], exists: null, create: "Bah\u00e7e" });
  assert.equal(pickerView(CATS, "  Bah\u00e7e  ").create, "Bah\u00e7e");
  // a part of a name lists that one and still offers to make the typed name
  assert.deepEqual(pickerView(CATS, "bel"), { rows: [CATS[0]], exists: null, create: "bel" });
  assert.equal(pickerView(CATS, "z".repeat(50)).create, "z".repeat(40));
  // nothing typed: nothing to make
  for (const q of ["", "   ", null, undefined]) assert.equal(pickerView(CATS, q).create, "", JSON.stringify(q));
});

await check("'already there': the typed name of a category, in any case or spacing or i, picks it and makes nothing", () => {
  const pickerView = need("pickerView");
  for (const [q, id] of [["belgesel", "c1"], ["  BELGESEL ", "c1"], ["\u00e7izgi   film", "c3"], ["inceleme", "c5"], ["\u0131rmak", "c6"], ["IRMAK", "c6"]]) {
    const v = pickerView(CATS, q);
    assert.equal(v.exists?.id, id, q);
    assert.equal(v.create, "", q);
    assert.ok(v.rows.includes(v.exists), `${q}: the one that is there stays in the list`);
  }
  // the same letters without their marks are another name
  assert.equal(pickerView(CATS, "muzik").exists, null);
  assert.equal(pickerView(CATS, "muzik").create, "muzik");
});

await check("Enter in the box: picks the one that is there, makes a new one, or does nothing while it's empty", () => {
  const enterAction = need("enterAction");
  assert.deepEqual(enterAction(CATS, "belgesel"), { pick: "c1" });
  assert.deepEqual(enterAction(CATS, " Bah\u00e7e "), { create: "Bah\u00e7e" });
  assert.deepEqual(enterAction(CATS, "bel"), { create: "bel" });
  assert.equal(enterAction(CATS, "   "), null);
  assert.deepEqual(enterAction([], "Bah\u00e7e"), { create: "Bah\u00e7e" });
});

await check("Save in a name box: the empty name and another one's name are refused; its own name unchanged sends nothing", () => {
  const saveAction = need("saveAction");
  assert.deepEqual(saveAction(CATS, "c4", "   "), { error: NAME });
  assert.deepEqual(saveAction(CATS, "c4", "Belgesel"), { error: TAKEN });
  assert.deepEqual(saveAction(CATS, "c4", " belGESEL"), { error: TAKEN });
  assert.deepEqual(saveAction(CATS, "c4", "\u0131nceleme"), { error: TAKEN });
  assert.deepEqual(saveAction(CATS, "c4", "M\u00fczik"), { same: true });
  assert.deepEqual(saveAction(CATS, "c4", "  M\u00fczik  "), { same: true });
  assert.deepEqual(saveAction(CATS, "c4", "M\u00dcZ\u0130K"), { name: "M\u00dcZ\u0130K" });
  assert.deepEqual(saveAction(CATS, "c4", "  M\u00fczik ve dans "), { name: "M\u00fczik ve dans" });
  assert.deepEqual(saveAction(CATS, "c4", "w".repeat(45)), { name: "w".repeat(40) });
});

await check("the typed part of a name is marked where it is, and not marked when folding moved the letters", () => {
  const matchParts = need("matchParts");
  assert.deepEqual(matchParts("Belgesel", "bel"), ["", "Bel", "gesel"]);
  assert.deepEqual(matchParts("Belgesel", "GESE"), ["Bel", "gese", "l"]);
  assert.deepEqual(matchParts("\u0130nceleme", "ince"), ["", "\u0130nce", "leme"]);
  assert.deepEqual(matchParts("Irmak", "\u0131r"), ["", "Ir", "mak"]);
  assert.equal(matchParts("Belgesel", ""), null);
  assert.equal(matchParts("Belgesel", "film"), null);
  assert.equal(matchParts("\u00c7izgi  film", "film"), null);
});

// ==================== the numbers on the rows ====================
// videos as the library sends them: a category id, or "" for none (one points at a category since deleted)
const VIDEOS = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, category: "c1" })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `w${i}`, category: "c4" })),
  { id: "x1", category: "c3" },
  ...Array.from({ length: 7 }, (_, i) => ({ id: `y${i}`, category: "" })),
];

await check("each row's count is the videos in that category; the counts add up to the videos with a category", () => {
  const countsOf = need("countsOf");
  const counts = countsOf(VIDEOS);
  assert.deepEqual(CATS.map((c) => counts.get(c.id) || 0), [12, 0, 1, 3, 0, 0]);
  assert.equal(CATS.reduce((sum, c) => sum + (counts.get(c.id) || 0), 0), VIDEOS.filter((v) => v.category).length);
  // the videos without one aren't counted anywhere
  assert.deepEqual([...counts.keys()].sort(), ["c1", "c3", "c4"]);
  assert.equal(countsOf([]).size, 0);
});

await check("the button shows the video's category, or none when it has none or it was deleted", () => {
  const assignedOf = need("assignedOf");
  assert.equal(assignedOf({ category: "c4" }, CATS), CATS[3]);
  assert.equal(assignedOf({ category: "" }, CATS), null);
  assert.equal(assignedOf({ category: "gone" }, CATS), null);
  assert.equal(assignedOf(undefined, CATS), null);
});

await check("rows say 1 video / N videos, and deleting says how many videos only leave it", () => {
  const videoCount = need("videoCount");
  const deleteNote = need("deleteNote");
  assert.deepEqual([0, 1, 2, 23].map(videoCount), ["0 videos", "1 video", "2 videos", "23 videos"]);
  assert.equal(deleteNote(1), "Videos stay; 1 video only leaves this category.");
  assert.equal(deleteNote(5), "Videos stay; 5 videos only leave this category.");
});

// every sentence the picker shows has its Turkish, and the names it shows aren't translated
const { text } = JSON.parse(readFileSync(new URL("../i18n/tr.json", import.meta.url), "utf8"));
const SHOWN = [
  "Category",
  "No category",
  "Search or type a new category",
  "New category name",
  "New category",
  "Category name",
  "{n} video",
  "{n} videos",
  "Edit",
  "Already exists",
  "Create “{name}” and add",
  // after the name, which is a <strong> of its own (bold, as in the design, and never translated)
  "is not the name of any category.",
  "already exists; no new one is made. Press it to add it to this video.",
  "No categories yet",
  "Type a name to make one and add this video to it.",
  "Delete “{name}”?",
  "Videos stay; {n} video only leaves this category.",
  "Videos stay; {n} videos only leave this category.",
  "Delete category",
  "Delete",
  "Cancel",
  "Save",
  "Close",
  "Clear",
];

await check("every sentence the picker shows has its Turkish; the server's messages too", () => {
  for (const key of SHOWN) assert.ok(key in text, key);
  for (const message of [NAME, TAKEN, rules.CATEGORY_ERRORS.gone, KID]) assert.ok(message in text, message);
  // the counts read the same in Turkish for one and for many
  assert.equal(text["{n} video"], "{n} video");
  assert.equal(text["{n} videos"], "{n} video");
});

await check("a category's name is never translated: the language layer leaves [data-category-name] as it is", () => {
  const layer = readFileSync(new URL("../i18n/layer.js", import.meta.url), "utf8");
  const data = layer.slice(layer.indexOf("const DATA = ["), layer.indexOf("].join"));
  assert.ok(data.includes('"[data-category-name]"'), "DATA has [data-category-name]");
});

// ==================== what the picker sends, through the server's gate ====================
let next = 0;
const newId = () => (++next).toString(16).padStart(24, "0");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// A home through lib/profileGate.js with HOMETUBE_CATEGORY_EDIT on: Alice (Music, Cartoons, a name with a
// Turkish capital dotted I) and a
// kids profile, two videos each; a TV watching as each. emitter(socket) is socket.emit as the picker uses it,
// and records what was sent.
async function home() {
  const COLORS = profileRules.COLORS;
  const mem = { profiles: [], links: [], cats: [] };
  const calls = [];
  const videos = [{ id: newId() }, { id: newId() }];
  const db = { videos: videos.map((v) => ({ ...v, channel: "ch", category: "" })), channels: [{ id: "ch", name: "Channel", follow: false }], categories: [] };
  const wire = (p) => profileRules.profileWire({ _id: p.id, ...p }, true);
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
      Object.assign(find(id), fields);
      return wire(find(id));
    },
    videoCounts: async () => new Map(),
    orphanCount: async () => 0,
    links: async (profile) => mem.links.filter((l) => l.profile === profile).map((l) => ({ ...l })),
    follows: async () => [],
    categories: async (profile) => mem.cats.filter((c) => c.profile === profile).map((c) => ({ id: c.id, name: c.name })),
    hasCategory: async (profile, id) => mem.cats.some((c) => c.profile === profile && c.id === id),
    addCategory: async (profile, name) => {
      calls.push(["addCategory", profile, name]);
      await settle();
      const c = { id: newId(), profile, name };
      mem.cats.push(c);
      return c.id;
    },
    renameCategory: async (profile, id, name) => {
      calls.push(["renameCategory", profile, id, name]);
      const c = mem.cats.find((x) => x.profile === profile && x.id === id);
      if (c) c.name = name;
      return !!c;
    },
    removeCategory: async (profile, id) => {
      calls.push(["removeCategory", profile, id]);
      mem.cats = mem.cats.filter((c) => !(c.profile === profile && c.id === id));
      mem.links.filter((l) => l.profile === profile && l.category === id).forEach((l) => delete l.category);
    },
    setLink: async (profile, video, fields) => {
      calls.push(["setLink", profile, video, fields]);
      const link = mem.links.find((l) => l.profile === profile && l.video === video);
      if (link && "category" in fields) fields.category ? (link.category = fields.category) : delete link.category;
      return !!link;
    },
  };
  const rooms = new Map();
  const sockets = new Map();
  const io = {
    sockets: { sockets, adapter: { rooms } },
    to: (room) => ({ emit: (name, payload) => (rooms.get(room) || new Set()).forEach((id) => sockets.get(id).got.push([name, payload])) }),
  };
  const log = { warn: () => {}, error: () => {}, log: () => {} };
  const upstream = { library: async () => JSON.parse(JSON.stringify(db)), removeVideo: async () => {}, followChannel: async () => ({}) };
  const gate = createGate({ store, io, upstream, log, kids: true, clock: () => 1_800_000_000_000, categoryEdit: true });
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
  // socket.emit(name, payload, answer) through the gate; sent: what went out, in order
  const emitter = (socket) => {
    const sent = [];
    const emit = (name, payload, answer) => {
      sent.push([name, payload]);
      socket.middleware([name, payload, answer], () => answer({ passed: true }));
    };
    return { emit, sent };
  };
  const tv = await connect();
  const ask = (name, payload) => new Promise((resolve) => tv.middleware([name, payload, resolve], () => resolve("passed")));
  const alice = await ask("profile:create", { name: "Alice" });
  const kid = await ask("profile:create", { name: "Kid", color: COLORS[3] });
  await ask("profile:update", { id: kid.id, kid: true });
  const cat = (profile, name) => {
    const c = { id: newId(), profile, name };
    mem.cats.push(c);
    return c.id;
  };
  const a = { music: cat(alice.id, "Music"), cartoons: cat(alice.id, "Cartoons"), review: cat(alice.id, "\u0130nceleme") };
  const k = { tales: cat(kid.id, "Tales") };
  for (const p of [alice, kid]) for (const v of videos) mem.links.push({ profile: p.id, video: v.id, addedAt: 1 });
  const aliceTv = await connect({ profile: alice.id });
  const kidTv = await connect({ profile: kid.id });
  const categoryOf = (profile, video) => mem.links.find((l) => l.profile === profile.id && l.video === video.id)?.category ?? "";
  const state = () => JSON.stringify(mem);
  return { mem, calls, videos, alice, kid, a, k, aliceTv, kidTv, emitter, categoryOf, state };
}

await check("create and add: a new name makes one category and puts this video in it (category:add, then video:category)", async () => {
  const createAndAdd = need("createAndAdd");
  const h = await home();
  const { emit, sent } = h.emitter(h.aliceTv);
  const res = await createAndAdd(emit, h.videos[0].id, "  Bah\u00e7e ");
  const made = h.mem.cats.find((c) => c.profile === h.alice.id && c.name === "Bah\u00e7e");
  assert.ok(made, "the category is there");
  assert.deepEqual(res, { id: made.id, existed: false });
  assert.deepEqual(sent, [["category:add", "  Bah\u00e7e "], ["video:category", { id: h.videos[0].id, category: made.id }]]);
  assert.equal(h.categoryOf(h.alice, h.videos[0]), made.id);
  assert.equal(h.categoryOf(h.alice, h.videos[1]), "", "the other video stays as it was");
  assert.equal(h.calls.filter(([n]) => n === "addCategory").length, 1);
});

await check("create and add: the name of a category there is (case, spaces, i) makes nothing and puts the video in that one", async () => {
  const createAndAdd = need("createAndAdd");
  const h = await home();
  for (const [name, id] of [["music", h.a.music], [" CARTOONS ", h.a.cartoons], ["inceleme", h.a.review]]) {
    const { emit, sent } = h.emitter(h.aliceTv);
    assert.deepEqual(await createAndAdd(emit, h.videos[1].id, name), { id, existed: true }, name);
    assert.deepEqual(sent.map(([n]) => n), ["category:add", "video:category"], name);
    assert.equal(h.categoryOf(h.alice, h.videos[1]), id, name);
  }
  assert.equal(h.calls.filter(([n]) => n === "addCategory").length, 0);
  assert.equal(h.mem.cats.filter((c) => c.profile === h.alice.id).length, 3);
});

await check("create and add pressed twice at once (a double click) makes one category, and both put the video in it", async () => {
  const createAndAdd = need("createAndAdd");
  const h = await home();
  const { emit } = h.emitter(h.aliceTv);
  const [one, two] = await Promise.all([createAndAdd(emit, h.videos[0].id, "News"), createAndAdd(emit, h.videos[0].id, "news")]);
  assert.equal(h.mem.cats.filter((c) => c.profile === h.alice.id && rules.categoryKey(c.name) === "news").length, 1);
  assert.equal(one.id, two.id);
  assert.deepEqual([one.existed, two.existed], [false, true]);
  assert.equal(h.categoryOf(h.alice, h.videos[0]), one.id);
});

await check("create and add with an empty name: the server's message, and the video isn't touched", async () => {
  const createAndAdd = need("createAndAdd");
  const h = await home();
  const before = h.state();
  const { emit, sent } = h.emitter(h.aliceTv);
  assert.deepEqual(await createAndAdd(emit, h.videos[0].id, "   "), { error: NAME });
  assert.deepEqual(sent.map(([n]) => n), ["category:add"]);
  assert.equal(h.state(), before);
});

await check("a kids profile with its lock shut: making, adding, renaming and deleting answer the kids message and write nothing", async () => {
  const h = await home();
  const before = h.state();
  const { emit, sent } = h.emitter(h.kidTv);
  assert.deepEqual(await need("createAndAdd")(emit, h.videos[0].id, "Cartoons"), { error: KID });
  assert.deepEqual(sent.map(([n]) => n), ["category:add"], "nothing more after the refusal");
  assert.deepEqual(await need("addToCategory")(emit, h.videos[0].id, h.k.tales), { error: KID });
  assert.deepEqual(await need("renameCategory")(emit, h.k.tales, "Stories"), { error: KID });
  assert.deepEqual(await need("removeCategory")(emit, h.k.tales), { error: KID });
  assert.equal(h.state(), before);
  assert.deepEqual(h.calls, []);
});

await check("picking a row puts the video in that category; 'No category' takes it out", async () => {
  const addToCategory = need("addToCategory");
  const h = await home();
  const { emit, sent } = h.emitter(h.aliceTv);
  assert.deepEqual(await addToCategory(emit, h.videos[0].id, h.a.cartoons), {});
  assert.equal(h.categoryOf(h.alice, h.videos[0]), h.a.cartoons);
  assert.deepEqual(await addToCategory(emit, h.videos[0].id, ""), {});
  assert.equal(h.categoryOf(h.alice, h.videos[0]), "");
  assert.deepEqual(sent, [
    ["video:category", { id: h.videos[0].id, category: h.a.cartoons }],
    ["video:category", { id: h.videos[0].id, category: "" }],
  ]);
});

await check("rename sends { id, name } and gets the saved name; the server's refusal comes back as it is", async () => {
  const renameCategory = need("renameCategory");
  const h = await home();
  const { emit, sent } = h.emitter(h.aliceTv);
  assert.deepEqual(await renameCategory(emit, h.a.music, "  Songs "), { id: h.a.music, name: "Songs" });
  assert.deepEqual(sent, [["category:rename", { id: h.a.music, name: "  Songs " }]]);
  assert.deepEqual(await renameCategory(emit, h.a.cartoons, "SONGS"), { error: TAKEN });
  assert.equal(h.mem.cats.find((c) => c.id === h.a.cartoons).name, "Cartoons");
});

await check("delete sends category:remove; the category goes and its videos stay, only out of it", async () => {
  const removeCategory = need("removeCategory");
  const addToCategory = need("addToCategory");
  const h = await home();
  const { emit, sent } = h.emitter(h.aliceTv);
  await addToCategory(emit, h.videos[0].id, h.a.music);
  assert.deepEqual(await removeCategory(emit, h.a.music), {});
  assert.deepEqual(sent.at(-1), ["category:remove", h.a.music]);
  assert.equal(h.mem.cats.some((c) => c.id === h.a.music), false);
  assert.equal(h.mem.links.filter((l) => l.profile === h.alice.id).length, 2, "both videos are still in the profile");
  assert.equal(h.categoryOf(h.alice, h.videos[0]), "");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "not ok"} - ${r.name}${r.ok ? "" : ` (${r.assertion ? "assertion" : "error"}: ${r.message})`}`);
assert.equal(failed.length, 0, `${failed.length} of ${results.length} category picker checks failed`);
console.log(`category picker ok (${results.length} checks, ${SHOWN.length} sentences)`);
