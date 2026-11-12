import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as rules from "../../lib/profileRules.js";
import {
  COLORS,
  NAME_MAX,
  SAVED,
  authFor,
  avatarStyle,
  columnsOf,
  forgetProfile,
  gridMove,
  initialOf,
  isBack,
  nextColor,
  plural,
  profileName,
  rememberProfile,
  savedProfile,
  showGate,
} from "./profile.js";

// a localStorage stand-in that counts writes
const memory = () => {
  const map = new Map();
  const s = {
    writes: 0,
    get length() {
      return map.size;
    },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      s.writes += 1;
      map.set(k, String(v));
    },
    removeItem: (k) => {
      s.writes += 1;
      map.delete(k);
    },
  };
  return s;
};

// the same colors, length and name rule as the server
assert.deepEqual(COLORS, rules.COLORS);
assert.equal(NAME_MAX, rules.NAME_MAX);
assert.equal(profileName("  Kiddo   the   Great  "), "Kiddo the Great");
assert.equal(SAVED.key, "hometube:profile");

// auth: the saved id, read again on every connection; nothing saved gives an empty auth
const store = memory();
const auth = authFor(store);
const seen = [];
auth((a) => seen.push(a));
rememberProfile("alice-profile-id", store);
auth((a) => seen.push(a));
forgetProfile(store);
auth((a) => seen.push(a));
assert.deepEqual(seen, [{}, { profile: "alice-profile-id" }, {}]);
assert.equal(savedProfile(store), "");

// forgetting when nothing is saved writes nothing (profiles off leave storage untouched)
const untouched = memory();
forgetProfile(untouched);
authFor(untouched)(() => {});
assert.equal(untouched.writes, 0);
assert.equal(untouched.length, 0);

// storage that throws (turned off, private mode) never breaks the app
const broken = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};
assert.equal(savedProfile(broken), "");
assert.doesNotThrow(() => rememberProfile("x", broken));
assert.doesNotThrow(() => forgetProfile(broken));
assert.equal(savedProfile(null), "");
let brokenAuth;
authFor(broken)((a) => (brokenAuth = a));
assert.deepEqual(brokenAuth, {});

// avatar colors with commas (older TV browsers)
assert.deepEqual(avatarStyle(200), { background: "hsl(200, 55%, 45%)" });
assert.deepEqual(avatarStyle(32, 60), { background: "hsl(32, 55%, 60%)" });

// initials: first letter, capital for the interface language
assert.equal(initialOf("alice"), "A");
assert.equal(initialOf("  kiddo"), "K");
assert.equal(initialOf("ivy"), "I");
assert.equal(initialOf("ivy", "tr"), "\u0130");
assert.equal(initialOf("\u0131rmak", "tr"), "I");
assert.equal(initialOf("\u{1F600} smile"), "\u{1F600}");
assert.equal(initialOf(""), "");
assert.equal(initialOf(undefined), "");

// a new profile's color: the first one nobody has, else the next in turn
assert.equal(nextColor([]), COLORS[0]);
assert.equal(nextColor([{ color: COLORS[0] }, { color: COLORS[2] }]), COLORS[1]);
assert.equal(nextColor(COLORS.map((color) => ({ color }))), COLORS[0]);
assert.equal(nextColor([...COLORS, COLORS[0]].map((color) => ({ color }))), COLORS[1]);

// the gate: only once the server said profiles are on, and only without a profile
assert.equal(showGate(null), false);
assert.equal(showGate(undefined), false);
assert.equal(showGate({ current: null, list: [], orphans: 3 }), true);
assert.equal(showGate({ current: null, list: [{ id: "a" }], orphans: 0, reason: "removed" }), true);
assert.equal(showGate({ current: { id: "a" }, list: [{ id: "a" }], orphans: 0 }), false);

// arrows in a grid of 7 tiles, 3 to a row
const move = (i, key) => gridMove(i, key, 7, 3);
assert.equal(move(0, "ArrowRight"), 1);
assert.equal(move(6, "ArrowRight"), 6);
assert.equal(move(0, "ArrowLeft"), 0);
assert.equal(move(4, "ArrowLeft"), 3);
assert.equal(move(1, "ArrowDown"), 4);
assert.equal(move(5, "ArrowDown"), 6);
assert.equal(move(6, "ArrowDown"), 6);
assert.equal(move(4, "ArrowUp"), 1);
assert.equal(move(2, "ArrowUp"), 2);
assert.equal(move(4, "Home"), 0);
assert.equal(move(1, "End"), 6);
assert.equal(move(1, "Enter"), null);
assert.equal(move(1, "toString"), null);
assert.equal(gridMove(0, "ArrowRight", 0, 3), null);
// one row (the TV): up and down stay
assert.equal(gridMove(2, "ArrowDown", 4), 2);
assert.equal(gridMove(2, "ArrowUp", 4), 2);
assert.equal(columnsOf([100, 100, 100.4, 300, 300]), 3);
assert.equal(columnsOf([100]), 1);

// Back: Escape and the remotes' own keys
assert.ok(isBack({ key: "Escape" }));
assert.ok(isBack({ key: "GoBack" }));
assert.ok(isBack({ key: "Unidentified", keyCode: 461 }));
assert.ok(isBack({ key: "XF86Back", keyCode: 10009 }));
assert.ok(!isBack({ key: "Backspace", keyCode: 8 }));

// one and many
assert.equal(plural(1, "Move {n} video", "Move {n} videos"), "Move 1 video");
assert.equal(plural(197, "Move {n} video", "Move {n} videos"), "Move 197 videos");
assert.equal(plural(0, "{n} video", "{n} videos"), "0 videos");

// every sentence the profile screens show has its Turkish
const { text } = JSON.parse(readFileSync(new URL("../i18n/tr.json", import.meta.url), "utf8"));
const SHOWN = [
  "Who's watching?",
  "Add profile",
  "Create your profile",
  "Everyone at home gets their own library: their own videos, categories and where they left off.",
  "Name",
  "Your name",
  "Color",
  "Color {n}",
  "Create profile",
  "Creating…",
  "Give the profile a name.",
  "There's already a profile with this name.",
  "That profile was removed. Pick another one.",
  "Arrow keys move · OK picks · this device remembers the pick",
  "{n} videos aren't in any profile yet.",
  "{n} video isn't in any profile yet.",
  "Move them from Settings › Profiles.",
  "Switch profile",
  "Manage profiles",
  "Watching as {name}",
  "Profiles",
  "Rename",
  "Save",
  "Saving…",
  "Delete profile",
  "Click again to delete",
  "Videos only this profile has stay on the server and become unassigned.",
  "Move them to",
  "Keep their categories",
  "Move {n} videos",
  "Move {n} video",
  "Moving…",
  "Click again to move",
  "Moved {n} videos to {name}.",
  "Moved {n} video to {name}.",
  "The number of unassigned videos changed. Try again.",
  "Pick a profile first.",
  "This profile: {size} in {n} videos",
  "This profile: {size} in {n} video",
  "Cleanup rules are off while profiles are on, so one person's rule can't delete another's videos.",
  "These Shorts are already saved in another profile. Add them from the channel page with Get videos.",
  "{n} saved videos",
  "{n} saved video",
  "Cancel",
];
for (const key of SHOWN) assert.ok(key in text, key);
// the server's messages are the same text
for (const message of Object.values(rules.ERRORS)) assert.ok(message in text, message);

console.log(`profile ok (${SHOWN.length} sentences)`);
