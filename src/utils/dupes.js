// The duplicate check's answer (lib/dupes.js, the `dupes` event, on with HOMETUBE_DUPES=1), shaped for the
// interface. Pure: the badge, the "Also in your library" box on the watch page and the Duplicates filter use it.
// It only tells: nothing here deletes or suggests deleting a video.

// the kinds worth telling about; "short", "none", "unrated" and "pending" say nothing
const WARN_KINDS = { same: true, inside: true, covered: true, contains: true, partial: true };
// a shorter shared piece is an opening or closing jingle, not the same episode (LIMITS.longSeconds in lib/dupeMatch.js)
export const LONG_SECONDS = 180;
// a share this close to 1 counts as all of a video
const WHOLE = 0.97;

export const warns = (d) => !!d && Object.hasOwn(WARN_KINDS, d.kind);

// The card badge only shows on videos that came in after the check was turned on: most videos saved
// before were kept on purpose, so a badge on all of them would be noise. The Duplicates view shows them all.
export const badgeFor = (d, all = false) => warns(d) && (all || d.source === "download");

// seconds covered by a list of [from, to] ranges
export const spanOf = (ranges) => {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return Math.round(total);
};

// One row per other video it shares content with, longest first: its longest shared piece (main), how many
// more pieces there are and how many seconds they share in all. has(id): the video is in the library.
export function rowsOf(d, has = () => true) {
  if (!warns(d)) return [];
  // videos found to hold all of this one (or held by it) stay even if a piece is short
  const listed = new Set(["same", "inside", "contains"].includes(d.kind) ? d.others || [] : []);
  const rows = new Map();
  for (const p of d.partners || []) {
    if (!has(p.id) || (p.seconds < LONG_SECONDS && !listed.has(p.id))) continue;
    if (!rows.has(p.id)) rows.set(p.id, []);
    rows.get(p.id).push(p);
  }
  return [...rows]
    .map(([id, pieces]) => {
      pieces.sort((a, b) => b.seconds - a.seconds);
      const heres = pieces.map((p) => p.here);
      return { id, main: pieces[0], more: pieces.length - 1, heres, seconds: spanOf(heres) };
    })
    .sort((a, b) => b.seconds - a.seconds);
}

// minutes of a video its rows share with the others, counted once
const sharedMinutes = (rows) => minutesOf(spanOf(rows.flatMap((r) => r.heres)));

// whether [from, to] is all of a video this long
export const isWhole = (from, to, duration) => duration > 0 && to - from >= WHOLE * duration;

// minutes, for "11 minutes of this video …"
export const minutesOf = (seconds) => Math.max(1, Math.round(seconds / 60));

// The box's sentence, in English (the language layer translates it): what this video shares, as a whole.
export function summaryOf(d, rows) {
  const n = rows.length;
  const all = d.coverage >= WHOLE;
  if (d.kind === "same") return n > 1 ? `The same video is saved ${n} more times.` : "The same video is saved once more.";
  if (d.kind === "inside" && n > 1) return all ? `All of this video is also inside ${n} other videos.` : `Nearly all of this video is also inside ${n} other videos.`;
  if (d.kind === "inside") return all ? "All of this video is also inside another video." : "Nearly all of this video is also inside another video.";
  if (d.kind === "covered" && n > 1) return all ? `All of this video is also in ${n} other videos, in parts.` : `Nearly all of this video is also in ${n} other videos, in parts.`;
  if (d.kind === "covered") return all ? "All of this video is also in another video, in parts." : "Nearly all of this video is also in another video, in parts.";
  if (d.kind === "contains") {
    const held = rows.filter((r) => (d.others || []).includes(r.id)).length || n;
    return held > 1 ? `This video has ${held} other saved videos in it.` : "This video has another saved video in it.";
  }
  const m = sharedMinutes(rows);
  return n > 1 ? `${m} minutes of this video are also in ${n} other videos.` : `${m} minutes of this video are also in another video.`;
}

// The card badge's words: short, and saying what the content shares rather than only that it does.
export function badgeText(d) {
  if (d.kind === "contains") {
    const n = (d.others || []).length;
    return n > 1 ? `Has ${n} saved videos in it` : "Has a saved video in it";
  }
  if (d.kind === "partial") return `${sharedMinutes(rowsOf(d))} min also in another video`;
  if (d.kind === "same") return "Same as a saved video";
  if (d.kind === "covered") return "Its parts are in other videos";
  return "Also inside another video";
}

// The Duplicates view: related videos next to each other, the biggest group first; in a group the
// videos holding others (compilations) lead. videos: the shown videos; dupes: the answer's videos.
const LEAD = { contains: 0, covered: 1, partial: 2, same: 3, inside: 4 };
export function groupOrder(videos, dupes) {
  const ids = new Set(videos.map((v) => v.id));
  const root = new Map([...ids].map((id) => [id, id]));
  const find = (id) => (root.get(id) === id ? id : (root.set(id, find(root.get(id))), root.get(id)));
  for (const id of ids) {
    for (const r of rowsOf(dupes[id], (x) => ids.has(x))) root.set(find(r.id), find(id));
  }
  const size = new Map();
  for (const id of ids) size.set(find(id), (size.get(find(id)) || 0) + 1);
  const rank = (v) => [-size.get(find(v.id)), find(v.id), LEAD[dupes[v.id]?.kind] ?? 9, -v.savedAt];
  const cmp = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  return [...videos].sort(cmp);
}

// ?t=<seconds> on a watch link: where the player starts, if it fits in the video (a row in the box links there).
export const startParam = (search, duration) => {
  const t = Number(/[?&]t=(\d+)(?:&|$)/.exec(search || "")?.[1] ?? NaN);
  return Number.isFinite(t) && t < duration - 5 ? t : null;
};
