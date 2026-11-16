// Editing categories (HOMETUBE_CATEGORY_EDIT=1): the rules that need no database, apart so they can be
// tested on their own. lib/categories.js applies them to the library's categories, lib/profileGate.js to
// a profile's.
import { categoryName } from "./profileRules.js";

// The events that exist only with the flag on; without it they're as unknown as any other.
export const CATEGORY_EVENTS = new Set(["category:rename"]);

// Clients offer renaming, and making a category from the watch page, only after hearing this: sent to
// every new connection, never while the feature is off.
export const NOTICE = "categories:edit";

// What category:rename answers when it can't. "name" is the library's own message for category:add.
export const CATEGORY_ERRORS = {
  name: "Give the category a name.",
  taken: "There's already a category with this name.",
  gone: "This category no longer exists.",
};

// Two names that differ only in case, in spaces or in a dotted or dotless i are the same category, so a
// name typed with a Turkish capital dotted I and the same name typed later in lower case don't make two
// (src/i18n/lang.js folds a search the same way).
export const categoryKey = (raw) =>
  categoryName(raw).normalize("NFC").toLowerCase().replace(/\u0307/g, "").replace(/\u0131/g, "i").replace(/\s+/g, " ");

// The category among categories [{ id, name }] that has raw's name, leaving out the one whose id is except.
export function sameName(categories, raw, except) {
  const key = categoryKey(raw);
  return categories.find((c) => c.id !== except && categoryKey(c.name) === key);
}

// What category:rename { id, name } does among categories [{ id, name }] (the library's, or one profile's):
// { name } to save, or { error }. Only the case of its own name may change; another one's name is taken.
export function renamePlan(categories, data) {
  const name = categoryName(data?.name);
  if (!name) return { error: CATEGORY_ERRORS.name };
  if (typeof data.id !== "string" || !categories.some((c) => c.id === data.id)) return { error: CATEGORY_ERRORS.gone };
  if (sameName(categories, name, data.id)) return { error: CATEGORY_ERRORS.taken };
  return { name };
}
