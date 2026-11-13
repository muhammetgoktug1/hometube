import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTranslator } from "../i18n/translator.js";
import { LONG_SECONDS, badgeFor, badgeText, groupOrder, isWhole, minutesOf, rowsOf, spanOf, startParam, summaryOf, warns } from "./dupes.js";

// The duplicate check's answer as the interface reads it, with made-up videos ("a", "b", …). Every
// sentence it builds has to be in the Turkish dictionary too.

const dict = JSON.parse(readFileSync(new URL("../i18n/tr.json", import.meta.url), "utf8"));
const tr = createTranslator(dict);
const said = (english, key, values = {}) => {
  assert.equal(tr.run(english), dict.text[key].replace(/\{(\w+)\}/g, (_, name) => values[name]), english);
  return english;
};

// one shared piece: from–to in this video, starting at `there` in the other one (seconds)
const piece = (id, from, to, there = 0) => ({ id, here: [from, to], there, seconds: to - from });

// the kinds worth telling about, and the ones that say nothing
for (const kind of ["same", "inside", "covered", "contains", "partial"]) assert.equal(warns({ kind }), true, kind);
for (const kind of ["short", "none", "unrated", "pending", "toString"]) assert.equal(warns({ kind }), false, kind);
assert.equal(warns(undefined), false);
assert.equal(rowsOf({ kind: "short", partners: [piece("b", 0, 600)] }).length, 0);

// the card badge: only on a video downloaded after the check was turned on, unless every card asks for it
assert.equal(badgeFor({ kind: "inside", source: "download" }), true);
assert.equal(badgeFor({ kind: "inside", source: "backfill" }), false);
assert.equal(badgeFor({ kind: "inside" }), false);
assert.equal(badgeFor({ kind: "inside", source: "backfill" }, true), true);
assert.equal(badgeFor({ kind: "short", source: "download" }, true), false);
assert.equal(badgeFor({ kind: "pending", source: "download" }), false);
assert.equal(badgeFor(undefined, true), false);

// seconds covered by ranges that may overlap, rounded
assert.equal(spanOf([[0, 60], [30, 90], [200, 260]]), 150);
assert.equal(spanOf([[10, 20], [12, 18]]), 10);
assert.equal(spanOf([[0, 10.4]]), 10);
assert.equal(spanOf([]), 0);

// minutes, rounded, never fewer than one
assert.deepEqual([0, 29, 89, 90, 150, 600, 629, 631].map(minutesOf), [1, 1, 1, 2, 3, 10, 10, 11]);

// "all of" a video: at least 97% of its length
assert.equal(isWhole(0, 97, 100), true);
assert.equal(isWhole(3, 99, 100), false);
assert.equal(isWhole(0, 10, 0), false);

// rows: one per other video, longest first; pieces shorter than a jingle drop out unless that video
// was found to hold all of this one (or be held by it); videos no longer in the library drop out too
assert.equal(LONG_SECONDS, 180);
const partial = { kind: "partial", coverage: 0.4, others: ["b", "c", "d", "e"], partners: [piece("b", 0, 300, 600), piece("e", 100, 400), piece("b", 400, 600, 1000), piece("c", 100, 250), piece("d", 0, 120)] };
const rows = rowsOf(partial);
assert.deepEqual(rows.map((r) => [r.id, r.more, r.seconds]), [["b", 1, 500], ["e", 0, 300]]);
assert.deepEqual(rows[0].main, piece("b", 0, 300, 600));
assert.deepEqual(rowsOf(partial, (id) => id !== "b").map((r) => r.id), ["e"]);
const inside = { kind: "inside", coverage: 1, source: "download", others: ["c"], partners: [piece("c", 0, 170, 44)] };
assert.deepEqual(rowsOf(inside).map((r) => r.id), ["c"]);

// the box's sentence for each kind, one other video and several, all of it or nearly all
const one = [piece("b", 0, 600)];
const three = [piece("b", 0, 600), piece("c", 0, 600), piece("d", 0, 600)];
const box = (d) => summaryOf(d, rowsOf(d));
said(box({ kind: "same", coverage: 1, others: ["b"], partners: one }), "The same video is saved once more.");
said(box({ kind: "same", coverage: 1, others: ["b", "c", "d"], partners: three }), "The same video is saved {n} more times.", { n: 3 });
said(box({ kind: "inside", coverage: 1, others: ["b"], partners: one }), "All of this video is also inside another video.");
said(box({ kind: "inside", coverage: 0.93, others: ["b"], partners: one }), "Nearly all of this video is also inside another video.");
said(box({ kind: "inside", coverage: 0.99, others: ["b", "c", "d"], partners: three }), "All of this video is also inside {n} other videos.", { n: 3 });
said(box({ kind: "inside", coverage: 0.9, others: ["b", "c", "d"], partners: three }), "Nearly all of this video is also inside {n} other videos.", { n: 3 });
said(box({ kind: "covered", coverage: 1, others: ["b"], partners: one }), "All of this video is also in another video, in parts.");
said(box({ kind: "covered", coverage: 0.95, others: ["b"], partners: one }), "Nearly all of this video is also in another video, in parts.");
said(box({ kind: "covered", coverage: 0.97, others: ["b", "c", "d"], partners: three }), "All of this video is also in {n} other videos, in parts.", { n: 3 });
said(box({ kind: "covered", coverage: 0.91, others: ["b", "c", "d"], partners: three }), "Nearly all of this video is also in {n} other videos, in parts.", { n: 3 });
said(box({ kind: "contains", coverage: 0.2, others: ["b"], partners: one }), "This video has another saved video in it.");
// a compilation counts the videos it holds, not every video it shares a stretch with
said(box({ kind: "contains", coverage: 0.5, others: ["b", "c"], partners: three }), "This video has {n} other saved videos in it.", { n: 2 });
// partial: the minutes shared, counted once however many videos share them
said(box(partial), "{m} minutes of this video are also in {n} other videos.", { m: 10, n: 2 });
said(box({ kind: "partial", coverage: 0.3, others: ["b"], partners: [piece("b", 30, 330)] }), "{n} minutes of this video are also in another video.", { n: 5 });

// the badge's words for each kind
said(badgeText({ kind: "same" }), "Same as a saved video");
said(badgeText(inside), "Also inside another video");
said(badgeText({ kind: "covered" }), "Its parts are in other videos");
said(badgeText({ kind: "contains", others: ["b"] }), "Has a saved video in it");
said(badgeText({ kind: "contains", others: ["b", "c", "d"] }), "Has {n} saved videos in it", { n: 3 });
said(badgeText(partial), "{n} min also in another video", { n: 10 });

// the rest of the box and the chip
for (const text of ["Also in your library", "All of this video", "In this video", "All of that video", "In that video", "+1 more shared part", "Duplicates", "Show less"]) assert.notEqual(tr.run(text), null, text);
said("+3 more shared parts", "+{n} more shared parts", { n: 3 });
said("Show 3 more", "Show {n} more", { n: 3 });

// the Duplicates view: the biggest group first, a compilation ahead of what it holds, then the newest
const video = (id, savedAt) => ({ id, savedAt });
const dupes = {
  a: { kind: "contains", others: ["b", "c"], partners: [piece("b", 0, 600), piece("c", 600, 1200)] },
  b: { kind: "inside", others: ["a"], partners: [piece("a", 0, 600)] },
  c: { kind: "inside", others: ["a"], partners: [piece("a", 0, 600, 600)] },
  x: { kind: "partial", others: ["y"], partners: [piece("y", 0, 300)] },
  y: { kind: "partial", others: ["x"], partners: [piece("x", 0, 300)] },
};
const shown = [video("x", 1), video("c", 3), video("y", 2), video("b", 4), video("a", 5)];
assert.deepEqual(groupOrder(shown, dupes).map((v) => v.id), ["a", "b", "c", "y", "x"]);
// a video left out of the view doesn't join two groups
assert.deepEqual(groupOrder(shown.filter((v) => v.id !== "a"), dupes).map((v) => v.id), ["y", "x", "b", "c"]);

// ?t= on a row's link: where the player starts, if it is inside the video
assert.equal(startParam("?t=44", 600), 44);
assert.equal(startParam("?list=1&t=12", 600), 12);
assert.equal(startParam("?t=0", 600), 0);
assert.equal(startParam("?t=596", 600), null);
assert.equal(startParam("?t=abc", 600), null);
assert.equal(startParam("?st=5", 600), null);
assert.equal(startParam("", 600), null);
assert.equal(startParam(undefined, 600), null);

console.log("dupes ok");
