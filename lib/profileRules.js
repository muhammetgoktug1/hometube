// Profiles (HOMETUBE_PROFILES=1): the rules that need no database, apart from lib/profiles.js so they
// can be tested on their own.

// How each socket.io event is handled while profiles are on (see lib/profileGate.js):
//   wrap  the library's own handler answers and its answer is narrowed down to the profile
//   take  answered for the profile; the library's handler runs only to create a video that isn't saved yet
//   own   the video has to be the profile's; kept for the profile, then the library's handler runs too
//   pass  shared by everyone, handled as without profiles
//   self  the profile events themselves
// An event missing here never reaches a handler, so one added later can't slip past the profiles.
export const ROUTES = {
  library: "wrap",
  "video:add": "take",
  settings: "pass",
  "settings:save": "pass",
  storage: "wrap",
  "storage:cleanup": "pass",
  "channel:follow": "take",
  "channel:browse": "wrap",
  "channel:refresh": "pass",
  "channel:stop": "take",
  "channel:download": "take",
  "video:retry": "own",
  "video:category": "take",
  "video:watched": "own",
  "video:position": "own",
  "video:remove": "take",
  "category:add": "take",
  "category:remove": "take",
  dupes: "wrap",
  "profile:list": "self",
  "profile:create": "self",
  "profile:update": "self",
  "profile:delete": "self",
  "profile:claim": "self",
};

// What a connection that hasn't picked a profile may still do; anything else answers ERRORS.pick.
export const OPEN = new Set(["settings", "storage", "profile:list", "profile:create", "profile:update", "profile:delete", "profile:claim"]);

export const ERRORS = {
  pick: "Pick a profile first.",
  name: "Give the profile a name.",
  taken: "There's already a profile with this name.",
  changed: "The number of unassigned videos changed. Try again.",
  shorts: "These Shorts are already saved in another profile. Add them from the channel page with Get videos.",
};

// The library a connection without a profile gets.
export const noProfile = () => ({ error: ERRORS.pick, videos: [], channels: [], categories: [] });

// Settings saved while profiles are on keep both cleanup rules off (one person's rule could delete
// another's videos), so turning profiles off later doesn't bring back a rule picked meanwhile.
export const lockedSettings = (data) => (data && typeof data === "object" ? { ...data, deleteWatchedDays: 0, keepPerChannel: 0 } : data);

// Avatar colors, as hues (hsl(h 55% 45%)); a new profile without one gets the next in turn.
export const COLORS = [200, 32, 140, 280, 350, 50];
export const NAME_MAX = 24;

export const isId = (id) => typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);

// A profile's name: one line, spaces collapsed, at most NAME_MAX characters; "" when there's none.
export function profileName(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  return [...name].slice(0, NAME_MAX).join("").trim();
}

// Two names that differ only in case are the same profile.
export const nameKey = (raw) => profileName(raw).normalize("NFC").toLowerCase();

export const pickColor = (color, count = 0) => (COLORS.includes(Number(color)) ? Number(color) : COLORS[count % COLORS.length]);

// The same rule as the library's categories.
export const categoryName = (name) => String(name || "").trim().slice(0, 40);

// The distinct video ids in a list of picked uploads ([{ ytId }]).
export const ytIdsOf = (videos) =>
  [...new Set((Array.isArray(videos) ? videos : []).map((v) => v?.ytId).filter((id) => typeof id === "string" && /^[\w-]{11}$/.test(id)))];

// The library as one profile sees it. lib: the library's own answer (every video, channel and
// category); links: the profile's videos [{ video, category, watchedAt, position, addedAt }];
// categories: its own [{ id, name }]; follows: the channel ids it follows. Each video shows the
// profile's category, watch time and position, and savedAt is when the profile added it.
export function libraryFor(lib, { profile, links, categories, follows }) {
  const byVideo = new Map(links.map((l) => [l.video, l]));
  const own = new Set(categories.map((c) => c.id));
  const followed = new Set(follows);
  const videos = [];
  for (const v of lib.videos) {
    const link = byVideo.get(v.id);
    if (!link) continue;
    videos.push({
      ...v,
      category: own.has(link.category) ? link.category : "",
      watchedAt: link.watchedAt || 0,
      position: link.position || 0,
      savedAt: link.addedAt || v.savedAt,
    });
  }
  videos.sort((a, b) => b.savedAt - a.savedAt);
  const used = new Set(videos.map((v) => v.channel));
  const channels = lib.channels.filter((c) => used.has(c.id) || followed.has(c.id)).map((c) => ({ ...c, follow: followed.has(c.id) }));
  return { ...lib, videos, channels, categories, profile };
}

// The storage page for one profile: the disk and the library's total stay as they are (a video is
// stored once however many profiles have it), the channels count only the profile's videos, and
// mine is the profile's share. videos: the profile's [{ channel, size }].
export function storageFor(st, videos) {
  const rows = new Map(st.channels.map((c) => [c.id, { ...c, count: 0, size: 0 }]));
  for (const v of videos) {
    const row = rows.get(v.channel);
    if (!row) continue;
    row.count += 1;
    row.size += v.size || 0;
  }
  return {
    ...st,
    channels: [...rows.values()].filter((c) => c.count).sort((a, b) => b.size - a.size),
    mine: { used: videos.reduce((sum, v) => sum + (v.size || 0), 0), count: videos.length },
  };
}

// A channel's uploads marked saved only when they're in the profile. saved: the profile's YouTube ids.
export const markSaved = (res, saved) => (Array.isArray(res?.videos) ? { ...res, videos: res.videos.map((u) => ({ ...u, saved: saved.has(u.ytId) })) } : res);

// The duplicate check's answer (lib/dupes.js) for one profile: only its videos, and only what they
// share with its other videos. mine: the profile's video ids.
export function dupesFor(res, mine) {
  if (!res || res.error) return res;
  const narrow = (d) => {
    if (!Array.isArray(d.partners)) return d;
    const partners = d.partners.filter((p) => mine.has(p.id));
    const others = (d.others || []).filter((id) => mine.has(id));
    return partners.length ? { ...d, others, partners } : { ...d, kind: d.kind === "unrated" ? d.kind : "none", coverage: 0, others: [], partners: [] };
  };
  if (res.videos) {
    const videos = Object.fromEntries(Object.entries(res.videos).filter(([id]) => mine.has(id)).map(([id, d]) => [id, narrow(d)]));
    const list = Object.values(videos);
    return { ...res, videos, total: list.length, checked: list.filter((d) => d.kind !== "pending").length };
  }
  return mine.has(res.id) ? narrow(res) : { error: "This video no longer exists." };
}

// What moving the unassigned videos to a profile writes. orphans: the videos no profile has
// [{ id, category, watchedAt, position, addedAt }]; oldCategories: the library's [{ id, name }] in
// their order; have: the profile's categories [{ id, name }]; followed: followed channels no profile
// follows yet; copy: false moves the videos without any category.
// Returns { create: [{ name, order }], links: [{ video, categoryName, watchedAt, position, addedAt }],
// follows }: categories are matched by name, so moving again creates nothing twice.
export function claimPlan({ orphans, oldCategories = [], have = [], followed = [], copy = true }) {
  const names = new Set(have.map((c) => c.name));
  const create = [];
  if (copy) {
    for (const c of oldCategories) {
      if (names.has(c.name)) continue;
      names.add(c.name);
      create.push({ name: c.name, order: have.length + create.length });
    }
  }
  const nameOf = new Map(copy ? oldCategories.map((c) => [c.id, c.name]) : []);
  const links = orphans.map((o) => ({
    video: o.id,
    categoryName: nameOf.get(o.category) || "",
    watchedAt: o.watchedAt || 0,
    position: o.position || 0,
    addedAt: o.addedAt,
  }));
  return { create, links, follows: [...followed] };
}
