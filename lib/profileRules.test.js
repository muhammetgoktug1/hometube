import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  ROUTES,
  OPEN,
  ERRORS,
  KIDS,
  KIDS_ERRORS,
  COLORS,
  NAME_MAX,
  kidMay,
  profileWire,
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

// every event the server listens to is routed: one added upstream breaks this test instead of
// slipping past the profiles (server.js and every module in lib/, so a new module is looked at too)
const listened = (file) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/socket\.on\("([^"]+)"/g)].map((m) => m[1]);
const modules = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
assert.ok(["dupes.js", "playlists.js", "profiles.js"].every((f) => modules.includes(f)), modules.join(" "));
const events = new Set([...listened("../server.js"), ...modules.flatMap((f) => listened(`./${f}`))]);
assert.ok(events.size >= 19, `found only ${events.size} events`);
for (const name of events) assert.ok(ROUTES[name], `${name} isn't routed`);
for (const kind of Object.values(ROUTES)) assert.ok(["wrap", "take", "own", "pass", "self"].includes(kind), kind);
for (const name of OPEN) assert.ok(ROUTES[name], `${name} is open but not routed`);
// only the shared reads and the profile events work without a profile
assert.deepEqual([...OPEN].filter((name) => !name.startsWith("profile:")).sort(), ["settings", "storage"]);
assert.deepEqual(noProfile(), { error: "Pick a profile first.", videos: [], channels: [], categories: [] });
assert.deepEqual(lockedSettings({ quality: 720, deleteWatchedDays: 30, keepPerChannel: 25 }), { quality: 720, deleteWatchedDays: 0, keepPerChannel: 0 });
assert.equal(lockedSettings(undefined), undefined);
assert.equal(ERRORS.shorts, "These Shorts are already saved in another profile. Add them from the channel page with Get videos.");

// kids profiles: every routed event has its decision, so one added later without one breaks this test
const undecided = (routes, kids) => Object.keys(routes).filter((name) => !["allow", "refuse"].includes(kids[name]));
assert.deepEqual(undecided(ROUTES, KIDS), []);
assert.deepEqual(undecided({ ...ROUTES, "video:new": "take" }, KIDS), ["video:new"]);
assert.deepEqual(Object.keys(KIDS).sort(), Object.keys(ROUTES).sort());
// a kids profile watches: it reads, and keeps where it left off and what it watched
assert.deepEqual(Object.keys(KIDS).filter(kidMay).sort(), ["channel:browse", "dupes", "library", "profile:list", "settings", "storage", "video:position", "video:watched"]);
// whatever adds, removes or changes videos, channels, categories, settings or profiles is refused
const refused = ["video:add", "video:remove", "video:category", "video:retry", "channel:download", "channel:follow", "channel:stop", "channel:refresh", "category:add", "category:remove"];
refused.push("settings:save", "storage:cleanup", "profile:create", "profile:update", "profile:delete", "profile:claim", "playlist:download", "playlist:browse");
assert.deepEqual(Object.keys(KIDS).filter((name) => !kidMay(name)).sort(), refused.sort());
// an event nobody decided on is refused
assert.equal(kidMay("video:stray"), false);
assert.deepEqual(KIDS_ERRORS, { kid: "Not available in a kids profile.", lastGrownUp: "Keep at least one profile that isn't a kids profile." });
// the errors there were already read the same, and stay the only ones in ERRORS
assert.deepEqual([ERRORS.pick, ERRORS.name, ERRORS.taken, ERRORS.changed], ["Pick a profile first.", "Give the profile a name.", "There's already a profile with this name.", "The number of unassigned videos changed. Try again."]);
assert.deepEqual(Object.keys(ERRORS), ["pick", "name", "taken", "changed", "shorts"]);

// a profile as clients get it: kid only with kids profiles on, never read otherwise
const saved = { _id: { toString: () => "ab".repeat(12) }, name: "Kid", nameKey: "kid", color: COLORS[1], kid: true, createdAt: 1_700_000_000_000 };
assert.deepEqual(profileWire(saved), { id: "ab".repeat(12), name: "Kid", color: COLORS[1] });
assert.equal(JSON.stringify(profileWire(saved)), JSON.stringify({ id: "ab".repeat(12), name: "Kid", color: COLORS[1] }));
assert.deepEqual(profileWire(saved, true), { id: "ab".repeat(12), name: "Kid", color: COLORS[1], kid: true });
assert.deepEqual(profileWire({ ...saved, kid: undefined }, true).kid, false);
assert.deepEqual(profileWire({ ...saved, kid: "yes" }, true).kid, false);

// the last profile that isn't a kids profile stays one, and stays
const grownUp = (id) => ({ id, kid: false });
const kid = (id) => ({ id, kid: true });
assert.equal(takesLastGrownUp([grownUp("a"), kid("k")], { id: "a", kid: true }), true);
assert.equal(takesLastGrownUp([grownUp("a"), kid("k")], { id: "a", removed: true }), true);
assert.equal(takesLastGrownUp([grownUp("a"), grownUp("b"), kid("k")], { id: "a", kid: true }), false);
assert.equal(takesLastGrownUp([grownUp("a"), grownUp("b"), kid("k")], { id: "b", removed: true }), false);
// the only profile can't be a kids profile, but can go (the next one starts over)
assert.equal(takesLastGrownUp([grownUp("a")], { id: "a", kid: true }), true);
assert.equal(takesLastGrownUp([grownUp("a")], { id: "a", removed: true }), false);
// kids profiles come and go freely; unmarking never takes anything
assert.equal(takesLastGrownUp([grownUp("a"), kid("k")], { id: "k", removed: true }), false);
assert.equal(takesLastGrownUp([grownUp("a"), kid("k")], { id: "k", kid: false }), false);
assert.equal(takesLastGrownUp([grownUp("a"), kid("k")], { id: "a", kid: false }), false);
assert.equal(takesLastGrownUp([grownUp("a"), kid("k")], { id: "a" }), false);
assert.equal(takesLastGrownUp([grownUp("a")], { id: "missing", kid: true }), false);

// names: one line, trimmed, at most NAME_MAX characters; case doesn't make another profile
assert.equal(profileName("  Alice \n  Smith "), "Alice Smith");
assert.equal(profileName("   "), "");
assert.equal(profileName(undefined), "");
assert.equal([...profileName("x".repeat(40))].length, NAME_MAX);
assert.equal(profileName("🙂".repeat(30)), "🙂".repeat(NAME_MAX));
assert.equal(nameKey(" ALICE "), nameKey("alice"));
assert.notEqual(nameKey("Alice"), nameKey("Kid"));
assert.equal(pickColor(COLORS[2]), COLORS[2]);
assert.equal(pickColor(String(COLORS[3])), COLORS[3]);
assert.equal(pickColor("red", 1), COLORS[1]);
assert.equal(pickColor(undefined, COLORS.length + 2), COLORS[2]);
assert.equal(categoryName("  Cartoons  "), "Cartoons");
assert.ok(isId("ab".repeat(12)));
assert.ok(!isId("ab".repeat(11)) && !isId(42) && !isId(undefined));
assert.deepEqual(ytIdsOf([{ ytId: "aaaaaaaaaaa" }, { ytId: "aaaaaaaaaaa" }, { ytId: "bad" }, null, { ytId: "bbbbbbbbbbb" }]), ["aaaaaaaaaaa", "bbbbbbbbbbb"]);
assert.deepEqual(ytIdsOf(undefined), []);

// the library through one profile's links
const T = 1_700_000_000_000;
const video = (id, extra) => ({ id, ytId: `${id}`.padEnd(11, "x"), channel: "c1", category: "old", savedAt: T, watchedAt: T, position: 99, status: "ready", ...extra });
const lib = {
  videos: [video("v1"), video("v2", { channel: "c2" }), video("v3", { savedAt: T - 5 }), video("v4", { channel: "c3" })],
  channels: [
    { id: "c1", name: "One", follow: true },
    { id: "c2", name: "Two", follow: false },
    { id: "c3", name: "Three", follow: true },
    { id: "c4", name: "Four", follow: true },
  ],
  categories: [{ id: "old", name: "Old" }],
};
const view = libraryFor(lib, {
  profile: { id: "p1", name: "Alice", color: COLORS[0] },
  links: [
    { video: "v1", category: "k1", watchedAt: 0, position: 0, addedAt: T },
    { video: "v3", category: "gone", watchedAt: T + 1, position: 12, addedAt: T + 10 },
    { video: "missing", category: "", watchedAt: 0, position: 0, addedAt: T },
  ],
  categories: [{ id: "k1", name: "Cartoons" }],
  follows: ["c4"],
});
// only its videos, newest added first, with its own category, watch time and position
assert.deepEqual(view.videos.map((v) => v.id), ["v3", "v1"]);
assert.deepEqual(view.videos.map((v) => [v.category, v.watchedAt, v.position, v.savedAt]), [["", T + 1, 12, T + 10], ["k1", 0, 0, T]]);
// the rest of a video stays as the library sends it
assert.equal(view.videos[1].ytId, lib.videos[0].ytId);
assert.equal(view.videos[1].status, "ready");
// channels of its videos plus the ones it follows; follow is the profile's
assert.deepEqual(view.channels.map((c) => [c.id, c.follow]), [["c1", false], ["c4", true]]);
assert.deepEqual(view.categories, [{ id: "k1", name: "Cartoons" }]);
assert.equal(view.profile.name, "Alice");
// the library's answer itself is left alone (it goes to the other profiles too)
assert.equal(lib.videos[0].category, "old");
assert.equal(lib.videos.length, 4);
// a profile with nothing
assert.deepEqual(libraryFor(lib, { profile: { id: "p2" }, links: [], categories: [], follows: [] }).videos, []);

// storage: the disk and total stay, channels and "mine" count the profile's videos
const st = {
  used: 1000,
  free: 5,
  total: 9,
  channels: [
    { id: "c1", name: "One", count: 3, size: 600 },
    { id: "c2", name: "Two", count: 1, size: 400 },
  ],
  cleanup: { count: 0, size: 0 },
};
const own = storageFor(st, [
  { channel: "c2", size: 400 },
  { channel: "c1", size: 100 },
]);
assert.deepEqual([own.used, own.free, own.total], [1000, 5, 9]);
assert.deepEqual(own.channels, [
  { id: "c2", name: "Two", count: 1, size: 400 },
  { id: "c1", name: "One", count: 1, size: 100 },
]);
assert.deepEqual(own.mine, { used: 500, count: 2 });
assert.deepEqual(storageFor(st, []).channels, []);

// a channel's uploads are "saved" when the profile has them
const browse = markSaved({ videos: [{ ytId: "a", saved: true }, { ytId: "b", saved: true }, { ytId: "c", saved: false }] }, new Set(["b", "c"]));
assert.deepEqual(browse.videos.map((u) => u.saved), [false, true, true]);
assert.deepEqual(markSaved({ error: "x" }, new Set()), { error: "x" });

// duplicates: only between the profile's own videos
const dupes = {
  checked: 3,
  total: 3,
  videos: {
    v1: { id: "v1", kind: "same", coverage: 1, others: ["v2"], partners: [{ id: "v2", seconds: 60 }] },
    v2: { id: "v2", kind: "same", coverage: 1, others: ["v1", "v3"], partners: [{ id: "v1", seconds: 60 }, { id: "v3", seconds: 50 }] },
    v3: { id: "v3", kind: "partial", coverage: 0.2, others: ["v2"], partners: [{ id: "v2", seconds: 50 }] },
  },
};
const narrowed = dupesFor(dupes, new Set(["v1", "v3"]));
assert.deepEqual(Object.keys(narrowed.videos), ["v1", "v3"]);
assert.deepEqual([narrowed.videos.v1.kind, narrowed.videos.v1.others, narrowed.videos.v1.partners], ["none", [], []]);
assert.deepEqual([narrowed.total, narrowed.checked], [2, 2]);
assert.deepEqual(dupesFor(dupes, new Set(["v1", "v2"])).videos.v2.others, ["v1"]);
assert.deepEqual(dupesFor(dupes.videos.v3, new Set(["v1"])), { error: "This video no longer exists." });
assert.equal(dupesFor(dupes.videos.v1, new Set(["v1", "v2"])).kind, "same");
assert.deepEqual(dupesFor({ id: "v9", kind: "pending" }, new Set(["v9"])), { id: "v9", kind: "pending" });

// moving the unassigned videos
const orphans = [
  { id: "a", category: "k-old", watchedAt: T, position: 30, addedAt: T - 100 },
  { id: "b", category: "", watchedAt: 0, position: 0, addedAt: T - 50 },
  { id: "c", category: "k-gone", watchedAt: 0, position: 5, addedAt: T - 10 },
];
const oldCategories = [
  { id: "k-old", name: "Cartoons" },
  { id: "k-two", name: "Music" },
  { id: "k-three", name: "Science" },
];
const withCategories = claimPlan({ orphans, oldCategories, have: [], followed: ["ch"] });
// every old category is copied in its order, the links keep where they were left and when they were saved
assert.deepEqual(withCategories.create, [
  { name: "Cartoons", order: 0 },
  { name: "Music", order: 1 },
  { name: "Science", order: 2 },
]);
assert.deepEqual(withCategories.links, [
  { video: "a", categoryName: "Cartoons", watchedAt: T, position: 30, addedAt: T - 100 },
  { video: "b", categoryName: "", watchedAt: 0, position: 0, addedAt: T - 50 },
  { video: "c", categoryName: "", watchedAt: 0, position: 5, addedAt: T - 10 },
]);
assert.deepEqual(withCategories.follows, ["ch"]);
// categories: false moves the videos without any
const bare = claimPlan({ orphans, oldCategories, have: [], copy: false });
assert.deepEqual(bare.create, []);
assert.ok(bare.links.every((l) => l.categoryName === ""));
// categories the profile has already (by name) are reused, not created twice
const again = claimPlan({ orphans, oldCategories, have: [{ id: "x", name: "Cartoons" }, { id: "y", name: "Music" }] });
assert.deepEqual(again.create, [{ name: "Science", order: 2 }]);
assert.equal(again.links[0].categoryName, "Cartoons");
// nothing to move: nothing created
assert.deepEqual(claimPlan({ orphans: [], oldCategories, have: oldCategories.map((c) => ({ id: c.id, name: c.name })) }), { create: [], links: [], follows: [] });

console.log(`profile rules ok (${events.size}/${events.size} events routed)`);
