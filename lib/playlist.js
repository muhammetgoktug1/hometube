import { videoIdOf } from "./youtube.js";

// Playlists (HOMETUBE_PLAYLISTS=1): the rules that need neither yt-dlp nor the database, apart from
// lib/playlists.js so they can be tested on their own.

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"]);
const ID = /^[\w-]{11}$/;
const LIST = /^[\w-]{2,80}$/;
// your own Liked videos, Watch later and Liked music: only you can see them
const PERSONAL = new Set(["LL", "WL", "LM"]);

// ponytail: the first 1000 of a longer playlist; page through it if someone ever needs more
export const LIMIT = 1000;

export const ERRORS = {
  link: "Paste a YouTube playlist link.",
  mix: "Mixes are made by YouTube for each viewer and keep changing. Open the playlist itself and copy its link.",
  private: "This playlist is private.",
  playlists: "This is a channel's list of playlists. Open one of them and copy its link.",
  paused: "YouTube asked HomeTube to slow down, so downloads are paused for a while. Try again once they resume.",
};

export const readError = (reason) => `Couldn't read the playlist: ${reason}`;

export const playlistUrl = (list) => `https://www.youtube.com/playlist?list=${list}`;

// What a pasted link (or a bare playlist id) points at: { list, video } for a playlist (video: the
// video the link was opened on, or ""), else { error, video } with error one of the keys of ERRORS.
export function playlistLink(raw) {
  const text = String(raw ?? "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    // a bare id; eleven characters are a video's
    return LIST.test(text) && !ID.test(text) ? listOf(text, "") : { error: "link", video: "" };
  }
  if (!HOSTS.has(url.hostname)) return { error: "link", video: "" };
  if (!url.hostname.endsWith("youtu.be") && /^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)\/playlists\/?$/.test(url.pathname)) {
    return { error: "playlists", video: "" };
  }
  // embed/videoseries?list=… is a playlist player, not a video
  const id = videoIdOf(text);
  const video = id && id !== "videoseries" ? id : "";
  const list = url.searchParams.get("list") || "";
  return LIST.test(list) ? listOf(list, video) : { error: "link", video };
}

function listOf(list, video) {
  // a Mix (RD…) is made up for whoever watches it; yt-dlp reads it as just the video
  if (list.startsWith("RD")) return { error: "mix", video };
  if (PERSONAL.has(list)) return { error: "private", video };
  return { list, video };
}

// yt-dlp's answer for a playlist that can't be read, in the words the library uses.
export function readFailure(message) {
  const text = String(message || "").trim();
  if (/is private|does not exist/i.test(text)) return ERRORS.private;
  return readError(text || "yt-dlp failed");
}

// yt-dlp's flat listing of a playlist (-J --flat-playlist) as the library keeps it:
// { playlist: { id, title, channel }, total, truncated, hidden, videos }.
// videos: [{ ytId, title, duration, channel: { ytId, name, url }, short, membersOnly, unavailable }] in the
// playlist's order, each once. Upcoming premieres and live streams are left out (hidden: how many),
// as on a channel page. A video without a channel id is private or removed: unavailable, like a
// members-only one, since neither can be downloaded. total: what YouTube counts; truncated: more than limit.
export function normalizePlaylist(info, limit = LIMIT) {
  if (!info || !Array.isArray(info.entries)) throw new Error("YouTube didn't answer with a playlist");
  const seen = new Set();
  const videos = [];
  let hidden = 0;
  let more = false;
  for (const e of info.entries) {
    if (!e || !ID.test(e.id || "") || seen.has(e.id)) continue;
    seen.add(e.id);
    if (["is_upcoming", "is_live"].includes(e.live_status)) {
      hidden += 1;
      continue;
    }
    if (videos.length === limit) {
      more = true;
      break;
    }
    const channel = typeof e.channel_id === "string" && e.channel_id ? e.channel_id : "";
    const membersOnly = e.availability === "subscriber_only";
    videos.push({
      ytId: e.id,
      title: String(e.title || e.id).slice(0, 300),
      duration: Number(e.duration) || 0,
      channel: {
        ytId: channel,
        name: String(e.channel || e.uploader || ""),
        url: channel ? e.channel_url || `https://www.youtube.com/channel/${channel}` : "",
      },
      short: /\/shorts\//.test(String(e.url || "")),
      membersOnly,
      unavailable: !channel || membersOnly,
    });
  }
  const counted = Number(info.playlist_count) || 0;
  return {
    playlist: { id: String(info.id || ""), title: String(info.title || ""), channel: String(info.channel || info.uploader || "") },
    total: Math.max(counted, videos.length + hidden),
    truncated: more || counted > limit,
    hidden,
    videos,
  };
}

// How many of the listed videos are saved, can't be downloaded, and are left to pick.
export function countsOf(videos) {
  const counts = { listed: videos.length, saved: 0, unavailable: 0, fresh: 0 };
  for (const v of videos) {
    if (v.saved) counts.saved += 1;
    if (v.unavailable) counts.unavailable += 1;
    if (!v.saved && !v.unavailable) counts.fresh += 1;
  }
  return counts;
}

// The answer to playlist:browse. read: normalizePlaylist's; video: the video the link was opened on;
// saved: the YouTube ids of the videos the library (or the profile) has. Saved marks and counts come
// from saved alone, so whoever passes it decides whose videos count.
export function browseAnswer(read, { video = "", saved = new Set() } = {}) {
  const videos = read.videos.map((v) => ({
    ytId: v.ytId,
    title: v.title,
    duration: v.duration,
    channel: { ytId: v.channel.ytId, name: v.channel.name },
    thumbnail: `https://i.ytimg.com/vi/${v.ytId}/mqdefault.jpg`,
    short: v.short,
    membersOnly: v.membersOnly,
    unavailable: v.unavailable,
    saved: saved.has(v.ytId),
  }));
  return {
    playlist: { ...read.playlist, url: playlistUrl(read.playlist.id) },
    video,
    total: read.total,
    limit: LIMIT,
    truncated: read.truncated,
    hidden: read.hidden,
    videos,
    counts: countsOf(videos),
  };
}

// The distinct YouTube ids a client picked: plain ids or { ytId } (what the channel import sends);
// nothing else it sends is used.
export function pickedIds(videos) {
  const ids = (Array.isArray(videos) ? videos : []).map((v) => (typeof v === "string" ? v : v?.ytId));
  return [...new Set(ids.filter((id) => typeof id === "string" && ID.test(id)))].slice(0, LIMIT);
}

// What playlist:download does with the picked ids, decided from the library's own reading of the
// playlist (read) and saved (the YouTube ids that count as saved): { saved, unavailable, picked }.
// saved: picked ids already saved; unavailable: ids not in the playlist, private, removed or members-only;
// picked: the listed videos to add, in the playlist's order.
export function planDownload(read, ids, saved) {
  const wanted = new Set(ids);
  const plan = { saved: [], unavailable: [], picked: [] };
  for (const v of read.videos) {
    if (!wanted.has(v.ytId)) continue;
    wanted.delete(v.ytId);
    if (saved.has(v.ytId)) plan.saved.push(v.ytId);
    else if (v.unavailable) plan.unavailable.push(v.ytId);
    else plan.picked.push(v);
  }
  plan.unavailable.push(...wanted);
  return plan;
}

// The videos in groups the library can queue at once: one channel and one kind (Shorts or not) each,
// in the order they first come up. [{ channel: { ytId, name, url }, short, videos }]
export function byChannel(videos) {
  const groups = new Map();
  for (const v of videos) {
    const key = `${v.channel.ytId} ${v.short ? "short" : "video"}`;
    if (!groups.has(key)) groups.set(key, { channel: v.channel, short: v.short, videos: [] });
    groups.get(key).videos.push(v);
  }
  return [...groups.values()];
}
