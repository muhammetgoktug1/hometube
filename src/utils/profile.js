// Profiles in the browser (HOMETUBE_PROFILES=1 on the server): pure helpers for the profile screens.
// The client only knows profiles are on when the server sends a `profiles` message; without one,
// nothing here runs and nothing is saved.
import { COLORS, NAME_MAX, profileName } from "../../lib/profileRules.js";

export { COLORS, NAME_MAX, profileName };

// where this device remembers who's watching: a profile id
export const SAVED = { key: "hometube:profile" };

const storageOf = (storage) => {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    // storage turned off in the browser
    return null;
  }
};

export const savedProfile = (storage) => {
  try {
    return storageOf(storage)?.getItem(SAVED.key) || "";
  } catch {
    return "";
  }
};

export const rememberProfile = (id, storage) => {
  try {
    storageOf(storage)?.setItem(SAVED.key, id);
  } catch {
    // private mode: the pick lasts until the page is closed
  }
};

export const forgetProfile = (storage) => {
  try {
    const s = storageOf(storage);
    if (s && s.getItem(SAVED.key) !== null) s.removeItem(SAVED.key);
  } catch {
    // nothing saved
  }
};

// socket.io's auth option: read again on every (re)connection, so switching only needs a reconnect
export const authFor = (storage) => (cb) => {
  const id = savedProfile(storage);
  cb(id ? { profile: id } : {});
};

// An avatar's color from its hue, written with commas, which older TV browsers read too.
export const avatarStyle = (hue, lightness = 45) => ({ background: `hsl(${Number(hue) || 0}, 55%, ${lightness}%)` });

// The first letter of a name, in capitals for the interface language (Turkish gives "i" a dotted capital).
export const initialOf = (name, lang) => {
  const first = [...String(name ?? "").trim()][0] || "";
  try {
    return first.toLocaleUpperCase(lang || undefined);
  } catch {
    return first.toUpperCase();
  }
};

// A color nobody uses yet, else the next in turn, for a new profile.
export const nextColor = (list = []) => {
  const used = new Set(list.map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[list.length % COLORS.length];
};

// Whether the profile screen stands in for the page, from the server's `profiles` message: never
// without one (profiles are off), and not once this connection has a profile.
export const showGate = (state) => !!state && !state.current;

// The arrow keys (a TV remote's too) in a grid of `count` tiles, `columns` to a row. They stop at
// the edges; down into a short last row lands on its last tile.
const MOVES = {
  ArrowRight: (i, last) => Math.min(i + 1, last),
  ArrowLeft: (i) => Math.max(i - 1, 0),
  ArrowDown: (i, last, cols) => (Math.floor(i / cols) < Math.floor(last / cols) ? Math.min(i + cols, last) : i),
  ArrowUp: (i, last, cols) => (i - cols >= 0 ? i - cols : i),
  Home: () => 0,
  End: (i, last) => last,
};

// the tile to go to, or null when the key isn't one of them
export const gridMove = (index, key, count, columns = count) => {
  const move = Object.prototype.hasOwnProperty.call(MOVES, key) ? MOVES[key] : null;
  if (!move || !count) return null;
  return move(index, count - 1, Math.max(1, columns));
};

// how many tiles share the first one's row
export const columnsOf = (tops) => Math.max(1, tops.filter((top) => Math.abs(top - tops[0]) < 2).length);

// Escape, or a TV remote's Back key (webOS 461, Tizen 10009).
export const isBack = (e) => e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || e.keyCode === 461 || e.keyCode === 10009;

// "{n} video" for one, "{n} videos" for more
export const plural = (n, one, many) => (n === 1 ? one : many).replace("{n}", n);
