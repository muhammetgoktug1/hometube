// Paging (HOMETUBE_PAGING=1): what the home and channel pages draw, so a big library doesn't put every card on the page.
// The home page's "All" view shows only the videos not watched yet, the newest few of each channel, and "Show more"
// adds a few more, taking turns between the channels; everything else (a category, a search, Duplicates, a channel's
// videos or Shorts) shows a page at a time.

// watched: played to at least this share of its length; one left halfway or never opened is still to watch
export const WATCHED_SHARE = 0.9;
// the home page's "All" view: each channel's newest few, and how many "Show more" adds
export const HOME_FIRST = 3;
export const HOME_MORE = 6;
// everywhere else: how many a page holds, and how many "Show more" adds
export const PAGE = 20;

export const isWatched = (v) => v.duration > 0 && v.position >= WATCHED_SHARE * v.duration;

// downloaded ones first (they can be watched now), then the newest upload; saved time when the upload date is unknown
const newestFirst = (a, b) => (b.status === "ready") - (a.status === "ready") || (b.uploadedAt || b.savedAt) - (a.uploadedAt || a.savedAt);

// The "All" view's queue: mixed, the videos in the home page's own order (mixFeed in feed.js), watched ones too,
// so a channel sits where its best placed video does. Returns { list, first }: the unwatched videos, each channel's
// newest first, taken a turn at a time (every channel's 1st, then every channel's 2nd, …), and how many of them make
// the first screen (up to HOME_FIRST of each channel).
export function homeQueue(mixed) {
  const channels = new Map();
  for (const v of mixed) if (!channels.has(v.channel)) channels.set(v.channel, []);
  for (const v of mixed) if (!isWatched(v)) channels.get(v.channel).push(v);
  const lists = [...channels.values()].map((list) => list.sort(newestFirst));
  const list = [];
  let first = 0;
  for (let turn = 0; lists.some((l) => l.length > turn); turn += 1) {
    for (const l of lists) if (l.length > turn) list.push(l[turn]);
    if (turn < HOME_FIRST) first = list.length;
  }
  return { list, first };
}

// A page of list after "Show more" was pressed more times: a page, and a page more each time. Returns
// { videos, total, left }; the button goes once left is 0.
export function pageOf(list, more) {
  const n = Math.min(list.length, PAGE * (more + 1));
  return { videos: list.slice(0, n), total: list.length, left: list.length - n };
}

// What the home page draws. shown: the videos in the order the page has them; main: the "All" view (no category,
// search or Duplicates). Returns what pageOf does; in "All", total counts the unwatched videos.
export function homePage(shown, main, more) {
  if (!main) return pageOf(shown, more);
  const { list, first } = homeQueue(shown);
  const n = Math.min(list.length, first + HOME_MORE * more);
  return { videos: list.slice(0, n), total: list.length, left: list.length - n };
}
