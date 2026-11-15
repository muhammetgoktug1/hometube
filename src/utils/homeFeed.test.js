import assert from "node:assert/strict";
import { mixFeed } from "./feed.js";
import { homePage, pageOf } from "./homeFeed.js";
import { libraryFor } from "../../lib/profileRules.js";

// A library shaped like a real one: one profile with one big channel (most never opened, a few left halfway, a few
// opened but never played), another with two channels, one of them half downloaded (queued videos have no upload
// date yet), and some videos watched to the end. The numbers on the page (3, 6, 20) are written out on purpose.
const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 15);
let n = 0;
const video = (channel, extra = {}) => {
  n += 1;
  return {
    id: `v${String(n).padStart(4, "0")}`,
    channel,
    status: "ready",
    category: "",
    short: false,
    duration: 600,
    position: 0,
    watchedAt: 0,
    uploadedAt: now - n * DAY,
    savedAt: now - (n % 40) * DAY,
    ...extra,
  };
};

// one channel, 197 videos: 2 left halfway, 3 opened but never played on, 4 watched to the end
const big = Array.from({ length: 197 }, () => video("c1"));
big[5].position = 240;
big[9].position = 300;
for (const i of [11, 12, 13]) big[i].watchedAt = now - DAY;
for (const i of [0, 2, 20, 30]) Object.assign(big[i], { position: 600, watchedAt: now - 2 * DAY });

// two channels: 90 downloaded; 43 downloaded + 96 queued without an upload date
const second = Array.from({ length: 90 }, () => video("c2"));
const third = [...Array.from({ length: 43 }, () => video("c3")), ...Array.from({ length: 96 }, () => video("c3", { status: "queued", uploadedAt: 0, savedAt: now }))];
// watched: exactly at 90% counts, just under it doesn't; one played past the end of its length
Object.assign(second[0], { position: 540, watchedAt: now });
Object.assign(second[1], { position: 539, watchedAt: now });
Object.assign(second[2], { position: 600, watchedAt: now - DAY });
Object.assign(third[0], { position: 610, watchedAt: now - DAY });
Object.assign(third[1], { position: 300, watchedAt: now - 3 * DAY });
const both = [...second, ...third];

const watched = (v) => v.duration > 0 && v.position >= 0.9 * v.duration;
// the home page: "All" mixes the library first (mixFeed), then pages it
const home = (videos, more, seed = 7) => homePage(mixFeed(videos, seed, now), true, more);
// every press of "Show more" until the button goes; [page after 0 presses, after 1, …]
const presses = (page) => {
  const out = [page(0)];
  while (out.at(-1).left > 0 && out.length < 500) out.push(page(out.length));
  return out;
};
const perChannel = (videos) => videos.reduce((m, v) => ({ ...m, [v.channel]: (m[v.channel] || 0) + 1 }), {});

const checks = {
  "watched videos are not on the home page, halfway and never played ones are": () => {
    for (const lib of [big, both]) {
      const all = presses((m) => home(lib, m)).at(-1).videos;
      assert.equal(all.filter(watched).length, 0);
      assert.equal(all.length, lib.filter((v) => !watched(v)).length);
    }
    const ids = new Set(presses((m) => home(big, m)).at(-1).videos.map((v) => v.id));
    for (const i of [5, 9, 11, 12, 13]) assert.ok(ids.has(big[i].id), `big[${i}]`);
    for (const i of [0, 2, 20, 30]) assert.ok(!ids.has(big[i].id), `big[${i}]`);
    const twos = new Set(presses((m) => home(both, m)).at(-1).videos.map((v) => v.id));
    assert.deepEqual([second[0], second[1], second[2], third[0], third[1]].map((v) => twos.has(v.id)), [false, true, false, false, true]);
  },

  "the first screen holds at most 3 of each channel": () => {
    assert.deepEqual(perChannel(home(big, 0).videos), { c1: 3 });
    assert.deepEqual(perChannel(home(both, 0).videos), { c2: 3, c3: 3 });
    const few = [video("c7"), video("c8"), video("c8"), ...Array.from({ length: 9 }, () => video("c9"))];
    assert.deepEqual(perChannel(home(few, 0).videos), { c7: 1, c8: 2, c9: 3 });
  },

  "each channel shows its newest unwatched videos, downloaded ones before queued ones": () => {
    const first = home(both, 0).videos;
    const newest = (list) => list.filter((v) => !watched(v) && v.status === "ready").sort((a, b) => b.uploadedAt - a.uploadedAt).slice(0, 3).map((v) => v.id);
    assert.deepEqual(first.filter((v) => v.channel === "c2").map((v) => v.id), newest(second));
    assert.deepEqual(first.filter((v) => v.channel === "c3").map((v) => v.id), newest(third));
    assert.equal(first.length, 6);
  },

  "channels keep the home page's order, and turns go a channel at a time": () => {
    const lib = ["c4", "c5", "c6", "c7", "c8"].flatMap((c, i) => Array.from({ length: 8 + i }, () => video(c, { savedAt: now - 60 * DAY })));
    // the channel watched last leans first in the mix: its best placed video puts the channel first
    lib.find((v) => v.channel === "c8").watchedAt = now;
    const mixed = mixFeed(lib, 3, now);
    const order = [...new Set(mixed.map((v) => v.channel))];
    assert.equal(order[0], "c8");
    const page = homePage(mixed, true, 0);
    assert.equal(page.videos.length, 15);
    for (let turn = 0; turn < 3; turn += 1) assert.deepEqual(page.videos.slice(turn * 5, turn * 5 + 5).map((v) => v.channel), order);
    // the 4th of each channel, in the same order, then the 5th
    assert.deepEqual(homePage(mixed, true, 1).videos.slice(15).map((v) => v.channel), [...order, order[0]]);
  },

  "Show more adds exactly 6 and never one twice": () => {
    for (const lib of [big, both]) {
      const pages = presses((m) => home(lib, m));
      assert.ok(pages.length > 10);
      pages.slice(1).forEach((p, i) => {
        const before = pages[i].videos;
        assert.deepEqual(p.videos.slice(0, before.length), before);
        assert.equal(p.videos.length - before.length, p.left > 0 ? 6 : Math.min(6, p.total - before.length));
      });
      const last = pages.at(-1).videos;
      assert.equal(new Set(last.map((v) => v.id)).size, last.length);
    }
  },

  "the last page has no button and holds every unwatched video": () => {
    const pages = presses((m) => home(big, m));
    const last = pages.at(-1);
    assert.equal(last.left, 0);
    assert.equal(last.total, 193);
    assert.equal(last.videos.length, 193);
    assert.equal(pages.length, 33);
    assert.ok(pages.slice(0, -1).every((p) => p.left > 0));
    // 3 on the first screen + 31 presses of 6 = 189, the 32nd brings the last 4
    assert.deepEqual([pages[0].videos.length, pages[31].videos.length, pages[32].videos.length], [3, 189, 193]);
  },

  "with nothing left to watch the home page draws nothing and has no button": () => {
    const done = big.slice(0, 10).map((v) => ({ ...v, position: v.duration }));
    assert.deepEqual(home(done, 0), { videos: [], total: 0, left: 0 });
  },

  "a channel's page draws 20, then 40, … and the last page has no button": () => {
    const list = big;
    const pages = presses((m) => pageOf(list, m));
    assert.deepEqual(pages.map((p) => p.videos.length), [20, 40, 60, 80, 100, 120, 140, 160, 180, 197]);
    assert.deepEqual(pages.map((p) => p.left), [177, 157, 137, 117, 97, 77, 57, 37, 17, 0]);
    pages.forEach((p) => assert.deepEqual(p.videos, list.slice(0, p.videos.length)));
    // watched ones are on the channel page
    assert.ok(pages[0].videos.includes(big[0]));
    // exactly a page: no button
    assert.equal(pageOf(big.slice(0, 20), 0).left, 0);
    assert.equal(pageOf(big.slice(0, 21), 0).left, 1);
  },

  "a category, a search or Duplicates draws 20 at a time, watched ones too, in the page's order": () => {
    const page = homePage(big, false, 0);
    assert.deepEqual(page.videos, big.slice(0, 20));
    assert.equal(page.total, 197);
    assert.deepEqual(homePage(big, false, 1).videos, big.slice(0, 40));
  },

  "with profiles, another profile's watching doesn't count": () => {
    const lib = { videos: big.slice(0, 12).map((v) => ({ ...v, position: v === big[0] ? 600 : 0 })), channels: [{ id: "c1", name: "" }], categories: [] };
    const links = (watchedIds) => lib.videos.map((v) => ({ video: v.id, category: "", watchedAt: 0, position: watchedIds.includes(v.id) ? 600 : 0, addedAt: now }));
    const ids = lib.videos.map((v) => v.id);
    const a = libraryFor(lib, { profile: { id: "a" }, links: links([]), categories: [], follows: [] });
    const b = libraryFor(lib, { profile: { id: "b" }, links: links(ids.slice(0, 11)), categories: [], follows: [] });
    const all = (l) => presses((m) => home(l.videos, m)).at(-1);
    // a: none watched (the video's own old position doesn't count either); b: only the last one left
    assert.equal(all(a).total, 12);
    assert.deepEqual(all(b).videos.map((v) => v.id), [ids[11]]);
  },
};

const failed = [];
for (const [name, check] of Object.entries(checks)) {
  try {
    check();
  } catch (err) {
    failed.push(name);
    console.error(`FAIL ${name}: ${err.name}: ${String(err.message).split("\n")[0]}`);
  }
}
if (failed.length) {
  console.error(`home feed: ${failed.length} of ${Object.keys(checks).length} checks failed`);
  process.exit(1);
}
console.log(`home feed ok (${Object.keys(checks).length} checks)`);
