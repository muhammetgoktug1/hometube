import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTranslator } from "../i18n/translator.js";
import { CONFIRM_OVER, asksFirst, confirmLine, inFilter, isFresh, isPlaylistLink, resultLine } from "./playlistLink.js";

// Which pasted links the add dialog reads with playlist:browse and which it adds as a video, with made-up
// ids: videos "vid" + 8 digits, playlists "PLsynthetic…". The server has the last word (lib/playlist.js);
// this only routes, so a link it reads by mistake comes back as "Paste a YouTube playlist link." and is
// added as a video, and one it misses is added as a video as before.

const PL = "PLsynthetic000000000000000000001";
const VIDEO = "vid00000001";

const ROUTES = [
  // a playlist
  [`https://www.youtube.com/playlist?list=${PL}`, true],
  [`https://youtube.com/playlist?list=${PL}`, true],
  [`https://m.youtube.com/playlist?list=${PL}&si=abc123`, true],
  [`https://music.youtube.com/playlist?list=${PL}`, true],
  [`  https://www.youtube.com/playlist?list=${PL}  `, true],
  // a video inside a playlist: read, so the dialog can ask "just this video or the whole playlist"
  [`https://www.youtube.com/watch?v=${VIDEO}&list=${PL}`, true],
  [`https://www.youtube.com/watch?v=${VIDEO}&list=${PL}&index=3`, true],
  [`https://www.youtube.com/watch?list=${PL}&v=${VIDEO}`, true],
  [`https://youtu.be/${VIDEO}?list=${PL}`, true],
  [`https://youtu.be/${VIDEO}?si=abc123&list=${PL}`, true],
  // a mix: read too, the server turns it down with the reason and the video, which can still be added alone
  [`https://www.youtube.com/watch?v=${VIDEO}&list=RD${VIDEO}`, true],
  [`https://www.youtube.com/watch?v=${VIDEO}&list=RDMM&start_radio=1`, true],
  // a channel's list of playlists: read, the server says to open one of them
  ["https://www.youtube.com/@somechannel/playlists", true],
  ["https://www.youtube.com/@somechannel/playlists/", true],
  ["https://www.youtube.com/channel/UCsynthetic0000000000001/playlists", true],
  ["https://www.youtube.com/c/somechannel/playlists", true],
  ["https://www.youtube.com/user/somechannel/playlists", true],
  // a bare playlist id, by the prefixes YouTube gives them
  [PL, true],
  ["OLsynthetic00000000000000000000001", true],
  ["UUsynthetic000000000000001", true],
  [`RD${VIDEO}`, true],
  ["WL", true],
  ["LL", true],
  // not a playlist: added as a video, as before
  [`https://www.youtube.com/watch?v=${VIDEO}`, false],
  [`https://youtu.be/${VIDEO}`, false],
  [`https://www.youtube.com/shorts/${VIDEO}`, false],
  ["https://www.youtube.com/@somechannel/shorts", false],
  ["https://www.youtube.com/@somechannel/videos", false],
  ["https://www.youtube.com/@somechannel", false],
  ["https://www.youtube.com/@playlists", false],
  ["https://www.youtube.com/watch?v=vid00000001&list=", false],
  ["https://www.youtube.com/watch?v=vid00000001&list=P", false],
  ["https://www.youtube.com/watch?v=vid00000001&playlist=PLsynthetic0001", false],
  [`https://www.youtube.com/watch?v=${VIDEO}#list=${PL}`, false],
  [`https://example.com/playlist?list=${PL}`, false],
  [`https://notyoutube.com/playlist?list=${PL}`, false],
  [`https://youtube.com.example.com/playlist?list=${PL}`, false],
  // eleven characters are a video's id, whatever they start with
  [VIDEO, false],
  ["PLsynthetic", false],
  ["somechannel", false],
  ["PL with space", false],
  ["", false],
  [null, false],
  [undefined, false],
];
for (const [link, playlist] of ROUTES) assert.equal(isPlaylistLink(link), playlist, String(link));

// the rows picked when the picker opens: neither saved nor private, removed or members only
assert.equal(isFresh({ saved: false, unavailable: false }), true);
assert.equal(isFresh({ saved: true, unavailable: false }), false);
assert.equal(isFresh({ saved: false, unavailable: true }), false);
assert.equal(isFresh({ saved: false, unavailable: true, membersOnly: true }), false);
assert.equal(isFresh({ saved: true, unavailable: true }), false);

// the filters: "Not saved yet" lists (and counts) only the videos that can be downloaded, the ones "Pick all not
// saved yet" picks; private, removed and members-only videos show under "Everything" alone
const row = (ytId, more = {}) => ({ ytId, saved: false, unavailable: false, membersOnly: false, ...more });
const listed = [
  row("vid00000001", { saved: true }),
  row("vid00000002"),
  row("vid00000003", { unavailable: true }),
  row("vid00000004", { unavailable: true, membersOnly: true }),
  row("vid00000005"),
  row("vid00000006", { saved: true, unavailable: true }),
];
const ids = (filter) => listed.filter((v) => inFilter(filter, v)).map((v) => v.ytId.slice(-1));
assert.deepEqual(ids("new"), ["2", "5"]);
assert.deepEqual(ids("new"), listed.filter(isFresh).map((v) => v.ytId.slice(-1)));
assert.deepEqual(ids("saved"), ["1", "6"]);
assert.deepEqual(ids("all"), ["1", "2", "3", "4", "5", "6"]);
assert.deepEqual(ids("anything else"), ids("all"));

// more than fifty picked videos: the download button asks once more first; fifty or fewer go at once
assert.equal(CONFIRM_OVER, 50);
assert.deepEqual([0, 1, 18, 50, 51, 1000].map(asksFirst), [false, false, false, false, true, true]);

// what the picker says, in English and through the Turkish dictionary (the language layer translates it on screen)
const dict = JSON.parse(readFileSync(new URL("../i18n/tr.json", import.meta.url), "utf8"));
const tr = createTranslator(dict);
const fill = (key, values) => dict.text[key].replace(/\{(\w+)\}/g, (_, name) => values[name]);
const said = (english, ...parts) => assert.equal(tr.run(english), parts.map(([key, values]) => fill(key, values)).join(" · "), english);
const decimal = (n) => n.replace(".", dict.decimal);

// the question: how many, how long and about how big
assert.equal(confirmLine(1000, 600_000, 164_000_000_000), "1000 videos will be downloaded · 166h 40m · ≈ 164.0 GB");
said(confirmLine(1000, 600_000, 164_000_000_000), [
  "{n} videos will be downloaded · {length} · ≈ {size}",
  { n: 1000, length: fill("{h}h {m}m", { h: 166, m: 40 }), size: fill("{n} GB", { n: decimal("164.0") }) },
]);
said(confirmLine(51, 3000, 450_000_000), ["{n} videos will be downloaded · {length} · ≈ {size}", { n: 51, length: fill("{n}m", { n: 50 }), size: fill("{n} MB", { n: 450 }) }]);
assert.equal(confirmLine(51, 0, 0), "51 videos will be downloaded");
said(confirmLine(51, 0, 0), ["{n} videos will be downloaded", { n: 51 }]);

// the line once the picker has closed: queued counts every video added, linked the ones another profile had
// downloaded already (only added, not downloaded again)
assert.equal(resultLine({ queued: 18, linked: 0 }), "18 videos queued for download");
assert.equal(resultLine({ queued: 1 }), "1 video queued for download");
assert.equal(resultLine({ queued: 5, linked: 2 }), "3 videos queued for download · 2 videos added to your library (downloaded already)");
assert.equal(resultLine({ queued: 3, linked: 3 }), "0 videos queued for download · 3 videos added to your library (downloaded already)");
assert.equal(resultLine({ queued: 2, linked: 1 }), "1 video queued for download · 1 video added to your library (downloaded already)");
assert.equal(resultLine({ queued: 0, linked: 0 }), "The picked videos are already in your library");
assert.equal(resultLine({}), resultLine({ queued: 0 }));
const queuedKey = "{n} videos queued for download";
const linkedKey = "{n} videos added to your library (downloaded already)";
said(resultLine({ queued: 18, linked: 0 }), [queuedKey, { n: 18 }]);
said(resultLine({ queued: 5, linked: 2 }), [queuedKey, { n: 3 }], [linkedKey, { n: 2 }]);
said(resultLine({ queued: 3, linked: 3 }), [queuedKey, { n: 0 }], [linkedKey, { n: 3 }]);
said(resultLine({ queued: 2, linked: 1 }), ["{n} video queued for download", { n: 1 }], ["{n} video added to your library (downloaded already)", { n: 1 }]);
said(resultLine({ queued: 0 }), ["The picked videos are already in your library", {}]);
// and the translations say the numbers: the Turkish keeps the sentence, not just the key
for (const key of [queuedKey, linkedKey, "{n} videos will be downloaded · {length} · ≈ {size}"]) assert.notEqual(dict.text[key], key);

// every sentence the add dialog's playlist part and the picker show has its Turkish
const SHOWN = [
  "Add a video, Shorts or playlist",
  "Video, Short, playlist or youtube.com/@channel/shorts link",
  "Reading the playlist on YouTube…",
  "This link is part of a playlist.",
  "Just this video",
  "Whole playlist ({n})",
  "With the whole playlist you see its videos and pick which to download.",
  "{n} videos aren't in your library yet",
  "{n} video isn't in your library yet",
  "Add just this video",
  "Playlist: {name}",
  "Showing the first {n} videos ({m} in the playlist)",
  "{n} live or upcoming video isn't listed",
  "{n} live or upcoming videos aren't listed",
  "Not saved yet",
  "Already saved",
  "Everything",
  "Pick all not saved yet",
  "Private or removed video",
  "Can't be downloaded",
  "Members only",
  "In library",
  "Nothing picked yet",
  "{n} videos picked · {length}",
  "{n} video picked · {length}",
  "Download the {n} picked videos",
  "Download the {n} picked video",
  "{n} videos will be downloaded · {length} · ≈ {size}",
  "{n} videos will be downloaded",
  "Start downloading",
  "{n} videos queued for download",
  "{n} video queued for download",
  "{n} videos added to your library (downloaded already)",
  "{n} video added to your library (downloaded already)",
  "The picked videos are already in your library",
  "Adding…",
  "Cancel",
];
for (const key of SHOWN) assert.ok(key in dict.text, key);

console.log(`playlist link ok (${ROUTES.length} links)`);
