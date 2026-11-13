// Whether a pasted link points at a YouTube playlist (or at a channel's list of playlists), so the add dialog
// reads it with playlist:browse instead of adding a video. Only routes: the server has the last word on what the
// link is (lib/playlist.js playlistLink) and answers anything it can't use with a reason.
// Below it, the playlist picker's own rules (PlaylistImport), kept here so they can be tested without a browser.
import { fmtBytes, fmtLength } from "./shortcuts.js";

const HOST = /(^|\.)(youtube\.com|youtu\.be)$/;
const LIST = /^[\w-]{2,80}$/;
const LIST_PARAM = /[?&]list=([\w-]{2,80})(&|$)/;
// a bare playlist id, by the prefixes YouTube gives them; eleven characters are a video's
const BARE = /^(PL|OL|UU|FL|RD|LL|WL|LM)[\w-]*$/;
const PLAYLISTS_PAGE = /^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)\/playlists\/?$/;

export const isPlaylistLink = (raw) => {
  const text = String(raw ?? "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return text.length !== 11 && LIST.test(text) && BARE.test(text);
  }
  if (!HOST.test(url.hostname)) return false;
  if (PLAYLISTS_PAGE.test(url.pathname)) return true;
  return LIST_PARAM.test(url.search);
};

// A listed video that can be picked: not saved (in the library, or the profile's) and not private, removed or
// members only. These are the ones picked when the picker opens.
export const isFresh = (v) => !v.saved && !v.unavailable;

// The picker's filters: "new" (not saved yet) lists only the videos that can be downloaded, so its number is
// the number "Pick all not saved yet" picks; private, removed and members-only videos show under "all" alone.
export const inFilter = (filter, v) => {
  if (filter === "new") return isFresh(v);
  if (filter === "saved") return !!v.saved;
  return true;
};

// More picked videos than this and the download button asks once more, in the picker, before queueing them.
export const CONFIRM_OVER = 50;
export const asksFirst = (picked) => picked > CONFIRM_OVER;

// What that question says: how many, how long and about how big (bytes: estimated, 0 when unknown).
export const confirmLine = (n, seconds, bytes) => {
  if (!seconds) return `${n} videos will be downloaded`;
  return `${n} videos will be downloaded · ${fmtLength(seconds)} · ≈ ${fmtBytes(bytes)}`;
};

// The line once the picker has closed, from playlist:download's answer: queued counts every video added, linked
// the ones the library had already (another profile's), added without being downloaded again.
export const resultLine = ({ queued = 0, linked = 0 } = {}) => {
  if (!queued) return "The picked videos are already in your library";
  const downloads = Math.max(0, queued - linked);
  const head = downloads === 1 ? `${downloads} video queued for download` : `${downloads} videos queued for download`;
  if (!linked) return head;
  return linked === 1
    ? `${head} · ${linked} video added to your library (downloaded already)`
    : `${head} · ${linked} videos added to your library (downloaded already)`;
};
