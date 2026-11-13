import assert from "node:assert/strict";
import { videoIdOf, channelShortsOf } from "./youtube.js";
import {
  LIMIT,
  ERRORS,
  readError,
  playlistUrl,
  playlistLink,
  readFailure,
  normalizePlaylist,
  countsOf,
  browseAnswer,
  pickedIds,
  planDownload,
  byChannel,
} from "./playlist.js";

// Synthetic ids only: videos "vid" + 8 digits, channels "UCsynthetic…", playlists "PLsynthetic…".
const vid = (n) => `vid${String(n).padStart(8, "0")}`;
const chan = (n) => `UCsynthetic${String(n).padStart(13, "0")}`;
const PL = "PLsyntheticPlaylist000000000000001";
const V = vid(1);

// ---- links: every form a playlist link comes in, and the ones that aren't playlists ----
const TABLE = [
  // a playlist page, with the share tracker the apps add
  [`https://www.youtube.com/playlist?list=${PL}`, { list: PL, video: "" }],
  [`https://www.youtube.com/playlist?list=${PL}&si=AbCdEfGh12345678`, { list: PL, video: "" }],
  [`https://youtube.com/playlist?list=${PL}&si=AbCdEfGh12345678`, { list: PL, video: "" }],
  [`https://m.youtube.com/playlist?list=${PL}`, { list: PL, video: "" }],
  [`https://music.youtube.com/playlist?list=${PL}`, { list: PL, video: "" }],
  [`  https://www.youtube.com/playlist?list=${PL}  `, { list: PL, video: "" }],
  // a video opened inside a playlist: the playlist, and which video the link showed
  [`https://www.youtube.com/watch?v=${V}&list=${PL}`, { list: PL, video: V }],
  [`https://www.youtube.com/watch?v=${V}&list=${PL}&index=3&t=42s`, { list: PL, video: V }],
  [`https://www.youtube.com/watch?list=${PL}&v=${V}`, { list: PL, video: V }],
  [`https://youtu.be/${V}?list=${PL}&si=AbCdEfGh12345678`, { list: PL, video: V }],
  [`https://music.youtube.com/watch?v=${V}&list=${PL}`, { list: PL, video: V }],
  [`https://www.youtube.com/embed/videoseries?list=${PL}`, { list: PL, video: "" }],
  // a channel's uploads, its videos / Shorts only, an album, favourites: flat playlists too
  [`https://www.youtube.com/playlist?list=UUsynthetic000000000000001`, { list: "UUsynthetic000000000000001", video: "" }],
  [`https://www.youtube.com/playlist?list=UULFsynthetic0000000000001`, { list: "UULFsynthetic0000000000001", video: "" }],
  [`https://www.youtube.com/playlist?list=UUSHsynthetic0000000000001`, { list: "UUSHsynthetic0000000000001", video: "" }],
  [`https://music.youtube.com/playlist?list=OLAK5uy_synthetic00000000000000000001`, { list: "OLAK5uy_synthetic00000000000000000001", video: "" }],
  [`https://www.youtube.com/playlist?list=FLsynthetic000000000000001`, { list: "FLsynthetic000000000000001", video: "" }],
  // a Mix, with or without the video it started from
  [`https://www.youtube.com/watch?v=${V}&list=RD${V}&start_radio=1`, { error: "mix", video: V }],
  [`https://www.youtube.com/watch?v=${V}&list=RDMM`, { error: "mix", video: V }],
  [`https://www.youtube.com/playlist?list=RDsynthetic0000000000000001`, { error: "mix", video: "" }],
  [`https://youtu.be/${V}?list=RDAMVM${V}`, { error: "mix", video: V }],
  // your own lists: only you can see them
  [`https://www.youtube.com/playlist?list=LL`, { error: "private", video: "" }],
  [`https://www.youtube.com/playlist?list=WL`, { error: "private", video: "" }],
  [`https://www.youtube.com/watch?v=${V}&list=WL`, { error: "private", video: V }],
  [`https://music.youtube.com/playlist?list=LM`, { error: "private", video: "" }],
  // a channel's Playlists tab lists playlists, not videos
  [`https://www.youtube.com/@synthetic/playlists`, { error: "playlists", video: "" }],
  [`https://www.youtube.com/channel/${chan(1)}/playlists`, { error: "playlists", video: "" }],
  [`https://www.youtube.com/c/synthetic/playlists/`, { error: "playlists", video: "" }],
  [`https://www.youtube.com/user/synthetic/playlists`, { error: "playlists", video: "" }],
  // a bare playlist id (what playlist:browse answers with)
  [PL, { list: PL, video: "" }],
  ["RDsynthetic0000000000000001", { error: "mix", video: "" }],
  ["WL", { error: "private", video: "" }],
  // not a playlist: a lone video, a channel, another site, a broken id, nothing
  [`https://www.youtube.com/watch?v=${V}`, { error: "link", video: V }],
  [`https://www.youtube.com/shorts/${V}`, { error: "link", video: V }],
  [V, { error: "link", video: "" }],
  ["https://www.youtube.com/@synthetic", { error: "link", video: "" }],
  ["https://www.youtube.com/@synthetic/shorts", { error: "link", video: "" }],
  [`https://www.youtube.com/playlist?list=${PL}%3Cscript%3E`, { error: "link", video: "" }],
  [`https://www.youtube.com/playlist?list=`, { error: "link", video: "" }],
  [`https://evil.example/playlist?list=${PL}`, { error: "link", video: "" }],
  [`youtube.com/playlist?list=${PL}`, { error: "link", video: "" }],
  ["not a link", { error: "link", video: "" }],
  ["", { error: "link", video: "" }],
  [undefined, { error: "link", video: "" }],
];
for (const [raw, want] of TABLE) assert.deepEqual(playlistLink(raw), want, String(raw));
// every error is one of the library's own sentences
for (const [, want] of TABLE) if (want.error) assert.ok(ERRORS[want.error], want.error);
assert.equal(ERRORS.mix, "Mixes are made by YouTube for each viewer and keep changing. Open the playlist itself and copy its link.");
assert.equal(ERRORS.private, "This playlist is private.");
assert.equal(playlistUrl(PL), `https://www.youtube.com/playlist?list=${PL}`);
// pasting a playlist video's link to add a video still adds just that video (video:add is unchanged)
assert.equal(videoIdOf(`https://www.youtube.com/watch?v=${V}&list=${PL}`), V);
assert.equal(videoIdOf(`https://youtu.be/${V}?list=${PL}`), V);
assert.equal(videoIdOf(`https://www.youtube.com/playlist?list=${PL}`), "");
assert.equal(channelShortsOf(`https://www.youtube.com/playlist?list=${PL}`), "");

// ---- yt-dlp's failures in the library's words ----
assert.equal(readFailure("YouTube said: This playlist is private."), ERRORS.private);
assert.equal(readFailure("The playlist does not exist."), ERRORS.private);
assert.equal(readFailure("Sign in to confirm you’re not a bot. This helps protect our community."), readError("Sign in to confirm you’re not a bot. This helps protect our community."));
assert.equal(readFailure("Unable to download API page: HTTP Error 503: Service Unavailable"), "Couldn't read the playlist: Unable to download API page: HTTP Error 503: Service Unavailable");
assert.equal(readFailure(""), "Couldn't read the playlist: yt-dlp failed");

// ---- yt-dlp's flat listing, in the shape it has (keys as yt-dlp writes them) ----
const thumbs = (id) => [168, 196, 246, 336].map((w) => ({ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg?sqp=synthetic${w}`, height: Math.round((w * 9) / 16), width: w }));
const entry = (id, extra = {}) => ({
  title: `Synthetic video ${id}`,
  thumbnails: thumbs(id),
  duration: 600,
  view_count: 1000,
  timestamp: null,
  live_status: null,
  availability: null,
  channel_url: `https://www.youtube.com/channel/${chan(1)}`,
  uploader_url: "https://www.youtube.com/@synthetic-one",
  creators: null,
  channel: "Synthetic One",
  channel_id: chan(1),
  uploader: "Synthetic One",
  uploader_id: "@synthetic-one",
  ie_key: "Youtube",
  id,
  _type: "url",
  url: `https://www.youtube.com/watch?v=${id}`,
  __x_forwarded_for_ip: null,
  ...extra,
});
// how yt-dlp lists a video the playlist still shows but nobody can watch: YouTube's title, nothing else
const gone = (id, title) => ({ ...entry(id), title, duration: null, channel_url: null, uploader_url: null, channel: null, channel_id: null, uploader: null, uploader_id: null, view_count: null });
// and as a newer yt-dlp lists one: no title at all, the channel keys left out
const bare = (id) => {
  const { channel, channel_id, uploader, uploader_id, ...rest } = gone(id, null);
  return rest;
};
const other = { channel_url: `https://www.youtube.com/channel/${chan(2)}`, channel: "Synthetic Two", channel_id: chan(2), uploader: "Synthetic Two", uploader_id: "@synthetic-two" };
const playlist = (entries, extra = {}) => ({
  id: PL,
  title: "Synthetic playlist",
  availability: "public",
  channel_follower_count: null,
  description: "",
  tags: [],
  thumbnails: thumbs(vid(1)),
  modified_date: "20260101",
  view_count: 5,
  playlist_count: entries.length,
  channel: "Synthetic One",
  channel_id: chan(1),
  uploader_id: "@synthetic-one",
  uploader: "Synthetic One",
  channel_url: `https://www.youtube.com/channel/${chan(1)}`,
  uploader_url: "https://www.youtube.com/@synthetic-one",
  _type: "playlist",
  entries,
  extractor_key: "YoutubeTab",
  extractor: "youtube:tab",
  webpage_url: playlistUrl(PL),
  original_url: playlistUrl(PL),
  webpage_url_basename: "playlist",
  webpage_url_domain: "youtube.com",
  release_year: null,
  epoch: 1_700_000_000,
  __files_to_move: {},
  _version: { version: "2026.01.01", current_git_head: null, release_git_head: "synthetic", repository: "yt-dlp/yt-dlp" },
  ...extra,
});

const entries = [
  entry(vid(1)),
  entry(vid(2), { duration: 61.5 }),
  entry(vid(3), other),
  entry(vid(4), { url: `https://www.youtube.com/shorts/${vid(4)}`, duration: 30 }),
  gone(vid(5), "[Private video]"),
  gone(vid(6), "[Deleted video]"),
  entry(vid(7), { availability: "subscriber_only" }),
  entry(vid(8), { live_status: "is_live" }),
  entry(vid(9), { live_status: "is_upcoming", duration: null }),
  entry(vid(10), { live_status: "was_live" }),
  entry(vid(1)),
  entry("not-an-id"),
  null,
  entry(vid(11), { title: "", duration: null, channel: null, uploader: "Synthetic Uploader", channel_url: null }),
  bare(vid(12)),
];
const read = normalizePlaylist(playlist(entries));
assert.deepEqual(read.playlist, { id: PL, title: "Synthetic playlist", channel: "Synthetic One" });
// live and upcoming left out as on a channel page; the repeated video and the broken id once / never
assert.deepEqual(read.videos.map((v) => v.ytId), [1, 2, 3, 4, 5, 6, 7, 10, 11, 12].map(vid));
assert.equal(read.hidden, 2);
assert.equal(read.total, entries.length);
assert.equal(read.truncated, false);
const byId = Object.fromEntries(read.videos.map((v) => [v.ytId, v]));
assert.deepEqual(byId[vid(1)], {
  ytId: vid(1),
  title: `Synthetic video ${vid(1)}`,
  duration: 600,
  channel: { ytId: chan(1), name: "Synthetic One", url: `https://www.youtube.com/channel/${chan(1)}` },
  short: false,
  membersOnly: false,
  unavailable: false,
});
assert.equal(byId[vid(2)].duration, 61.5);
assert.deepEqual(byId[vid(3)].channel, { ytId: chan(2), name: "Synthetic Two", url: `https://www.youtube.com/channel/${chan(2)}` });
assert.equal(byId[vid(4)].short, true);
// private and removed: no channel, so unavailable; members-only: unavailable too
for (const n of [5, 6, 12]) assert.deepEqual([byId[vid(n)].unavailable, byId[vid(n)].channel, byId[vid(n)].duration], [true, { ytId: "", name: "", url: "" }, 0]);
assert.equal(byId[vid(5)].title, "[Private video]");
// no title at all: the id stands in, as on a channel page
assert.equal(byId[vid(12)].title, vid(12));
assert.deepEqual([byId[vid(7)].membersOnly, byId[vid(7)].unavailable], [true, true]);
assert.equal(byId[vid(10)].unavailable, false);
// missing fields fall back as the channel list does; a channel without its link gets one from its id
assert.deepEqual([byId[vid(11)].title, byId[vid(11)].duration, byId[vid(11)].channel], [vid(11), 0, { ytId: chan(1), name: "Synthetic Uploader", url: `https://www.youtube.com/channel/${chan(1)}` }]);
// a video instead of a playlist (what yt-dlp gives back for a Mix) isn't one
assert.throws(() => normalizePlaylist(entry(vid(1))), /didn't answer with a playlist/);
assert.throws(() => normalizePlaylist(undefined), /didn't answer with a playlist/);
assert.deepEqual(normalizePlaylist(playlist([])).videos, []);

// at most LIMIT videos; a longer playlist says so
assert.equal(LIMIT, 1000);
const many = (n) => Array.from({ length: n }, (_, i) => entry(vid(100 + i)));
const long = normalizePlaylist(playlist(many(LIMIT + 1), { playlist_count: 1500 }));
assert.deepEqual([long.videos.length, long.truncated, long.total], [LIMIT, true, 1500]);
const exact = normalizePlaylist(playlist(many(LIMIT)));
assert.deepEqual([exact.videos.length, exact.truncated, exact.total], [LIMIT, false, LIMIT]);
// yt-dlp asked for fewer than the playlist has: YouTube's count still says it's longer
assert.deepEqual([normalizePlaylist(playlist(many(3), { playlist_count: 1200 })).truncated, normalizePlaylist(playlist(many(3), { playlist_count: 1200 })).total], [true, 1200]);
assert.equal(normalizePlaylist(playlist(many(3), { playlist_count: null })).total, 3);
// a smaller limit for the channel-sized case
assert.deepEqual([normalizePlaylist(playlist(many(5)), 2).videos.length, normalizePlaylist(playlist(many(5)), 2).truncated], [2, true]);

// ---- the answer to playlist:browse: saved marks and counts from the given ids only ----
const saved = new Set([vid(2), vid(5), vid(999)]);
const answer = browseAnswer(read, { video: vid(2), saved });
assert.deepEqual(Object.keys(answer), ["playlist", "video", "total", "limit", "truncated", "hidden", "videos", "counts"]);
assert.deepEqual(answer.playlist, { id: PL, title: "Synthetic playlist", channel: "Synthetic One", url: playlistUrl(PL) });
assert.deepEqual([answer.video, answer.total, answer.limit, answer.truncated, answer.hidden], [vid(2), entries.length, LIMIT, false, 2]);
assert.deepEqual(Object.keys(answer.videos[0]), ["ytId", "title", "duration", "channel", "thumbnail", "short", "membersOnly", "unavailable", "saved"]);
assert.deepEqual(answer.videos[0].channel, { ytId: chan(1), name: "Synthetic One" });
assert.equal(answer.videos[0].thumbnail, `https://i.ytimg.com/vi/${vid(1)}/mqdefault.jpg`);
assert.deepEqual(answer.videos.filter((v) => v.saved).map((v) => v.ytId), [vid(2), vid(5)]);
assert.deepEqual(answer.counts, { listed: 10, saved: 2, unavailable: 4, fresh: 5 });
assert.deepEqual(countsOf(answer.videos), answer.counts);
// whose ids count is up to the caller: another set gives an answer that differs only in its marks and counts
const none = browseAnswer(read, { video: vid(2), saved: new Set() });
assert.deepEqual(none.counts, { listed: 10, saved: 0, unavailable: 4, fresh: 6 });
const strip = (a) => ({ ...a, counts: null, videos: a.videos.map((v) => ({ ...v, saved: null })) });
assert.deepEqual(strip(answer), strip(none));
// the reading itself is left alone (it's kept and given to the next one asking)
assert.equal(read.videos[0].saved, undefined);
assert.deepEqual(browseAnswer(read).video, "");

// ---- what the client picked: ids only ----
assert.deepEqual(pickedIds([vid(1), { ytId: vid(2), title: "spoofed", channel: "spoofed" }, vid(1), "bad", 42, null, { ytId: "x" }]), [vid(1), vid(2)]);
assert.deepEqual(pickedIds(undefined), []);
assert.deepEqual(pickedIds("not a list"), []);
assert.equal(pickedIds(many(LIMIT + 5).map((e) => e.id)).length, LIMIT);

// ---- planning a download from the library's own reading ----
const plan = planDownload(read, [vid(3), vid(2), vid(5), vid(7), vid(1), vid(4), vid(404), vid(6)], new Set([vid(2), vid(6)]));
// saved first (whatever YouTube shows now), then what can't be downloaded or isn't in the playlist
assert.deepEqual(plan.saved, [vid(2), vid(6)]);
assert.deepEqual(plan.unavailable, [vid(5), vid(7), vid(404)]);
// the rest in the playlist's order, with the library's details (never the client's)
assert.deepEqual(plan.picked.map((v) => v.ytId), [vid(1), vid(3), vid(4)]);
assert.equal(plan.picked[0].title, `Synthetic video ${vid(1)}`);
assert.deepEqual(planDownload(read, [], new Set()), { saved: [], unavailable: [], picked: [] });

// ---- one queue call per channel and kind ----
const groups = byChannel(read.videos.filter((v) => !v.unavailable));
assert.deepEqual(
  groups.map((g) => [g.channel.ytId, g.short, g.videos.map((v) => v.ytId)]),
  [
    [chan(1), false, [vid(1), vid(2), vid(10), vid(11)]],
    [chan(2), false, [vid(3)]],
    [chan(1), true, [vid(4)]],
  ],
);
assert.deepEqual(groups[1].channel, { ytId: chan(2), name: "Synthetic Two", url: `https://www.youtube.com/channel/${chan(2)}` });
assert.deepEqual(byChannel([]), []);

console.log(`playlist ok (address table ${TABLE.length}/${TABLE.length})`);
