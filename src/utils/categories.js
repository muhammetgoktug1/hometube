// The category picker on the watch page (src/components/CategoryPicker), while the server offers category
// editing (HOMETUBE_CATEGORY_EDIT): pure helpers, so they can be tested without a browser.

// A category's name as the server keeps it: trimmed, at most CATEGORY_MAX characters (lib/profileRules.js).
export const CATEGORY_MAX = 40;
export const categoryName = (name) =>
  String(name || "")
    .trim()
    .slice(0, CATEGORY_MAX);

// Two names that differ only in case, in spaces or in a dotted or dotless i are the same category, the
// server's rule (lib/categoryRules.js): what the picker filters by, and how it knows a typed name is there.
// (normalize() with no form is NFC, as on the server)
export const categoryKey = (raw) =>
  categoryName(raw).normalize().toLowerCase().replace(/\u0307/g, "").replace(/\u0131/g, "i").replace(/\s+/g, " ");

// The server's messages, shown before anything is sent too.
export const CATEGORY_ERRORS = {
  name: "Give the category a name.",
  taken: "There's already a category with this name.",
};

// What the picker shows for what is typed in its box, among the profile's categories [{ id, name }]:
//   rows    the categories whose name holds the typed text (all of them while the box is empty), in order
//   exists  the category that has the typed name, or null; then nothing is made
//   create  the name a new category gets ("" while the box is empty or the name is there already)
export function pickerView(categories, query) {
  const key = categoryKey(query);
  if (!key) return { rows: categories, exists: null, create: "" };
  const rows = categories.filter((c) => categoryKey(c.name).includes(key));
  const exists = rows.find((c) => categoryKey(c.name) === key) || null;
  return { rows, exists, create: exists ? "" : categoryName(query) };
}

// The part of name that matches the typed text, for marking it: [before, match, after], or null when
// nothing is typed, it doesn't match, or folding changed the name's length (then no place can be marked).
export function matchParts(name, query) {
  const key = categoryKey(query);
  const folded = categoryKey(name);
  const at = key ? folded.indexOf(key) : -1;
  if (at < 0 || folded.length !== name.length) return null;
  return [name.slice(0, at), name.slice(at, at + key.length), name.slice(at + key.length)];
}

// What a rename of category id to name would be refused for, before it is sent: the empty name, or the name
// of another of the categories. Changing only the case of its own name is fine. null when it can be sent.
export function renameError(categories, id, name) {
  const key = categoryKey(name);
  if (!key) return CATEGORY_ERRORS.name;
  if (categories.some((c) => c.id !== id && categoryKey(c.name) === key)) return CATEGORY_ERRORS.taken;
  return null;
}

// What Enter in the picker's box does: { pick: id } for the category that has the typed name, { create: name }
// for a name there's no category for, null while the box is empty.
export function enterAction(categories, query) {
  const { exists, create } = pickerView(categories, query);
  if (exists) return { pick: exists.id };
  return create ? { create } : null;
}

// What Save (or Enter) in a category's name box does: { error } before anything is sent, { same: true } when
// the name is the one it has (nothing to send), else { name } to send.
export function saveAction(categories, id, draft) {
  const error = renameError(categories, id, draft);
  if (error) return { error };
  const name = categoryName(draft);
  return categories.some((c) => c.id === id && c.name === name) ? { same: true } : { name };
}

// ---- what the picker sends; emit is socket.emit (name, payload, answer). Each resolves with the answer ({} for none).

// Puts the video in the category ("" for none).
export const addToCategory = (emit, video, category) =>
  new Promise((resolve) => emit("video:category", { id: video, category }, (res) => resolve(res || {})));

// Makes a category called name and puts the video in it. A name the profile has a category for already makes
// nothing: the server answers that one ({ id, existed: true }) and the video goes there. → { id, existed } or { error }.
export async function createAndAdd(emit, video, name) {
  const made = await new Promise((resolve) => emit("category:add", name, (res) => resolve(res || {})));
  if (!made.id) return { error: made.error || "" };
  const added = await addToCategory(emit, video, made.id);
  return added.error ? { error: added.error } : { id: made.id, existed: !!made.existed };
}

// → { id, name } or { error }
export const renameCategory = (emit, id, name) =>
  new Promise((resolve) => emit("category:rename", { id, name }, (res) => resolve(res || {})));

// The videos stay; they only leave the category.
export const removeCategory = (emit, id) => new Promise((resolve) => emit("category:remove", id, (res) => resolve(res || {})));

// How many of the videos [{ category }] are in each category: Map id → count.
export function countsOf(videos) {
  const counts = new Map();
  for (const v of videos) if (v.category) counts.set(v.category, (counts.get(v.category) || 0) + 1);
  return counts;
}

// The category a video [{ category }] shows on its button: one of categories, or null (no category, or one
// that is gone).
export const assignedOf = (video, categories) => (video?.category && categories.find((c) => c.id === video.category)) || null;

// "12 videos" on a row.
export const videoCount = (n) => (n === 1 ? `${n} video` : `${n} videos`);

// What deleting a category with n videos does to them, said before it's done.
export const deleteNote = (n) =>
  n === 1 ? `Videos stay; ${n} video only leaves this category.` : `Videos stay; ${n} videos only leave this category.`;
