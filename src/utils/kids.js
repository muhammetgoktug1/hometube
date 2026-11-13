// Kids profiles in the browser (HOMETUBE_KIDS=1 on the server, with profiles on): pure helpers.
// The client only knows kids profiles exist when the server's `profiles` message gives the current profile a
// boolean `kid`; without one every helper here says "off" and nothing is read or saved.

// The parent lock: holding its row for holdMs opens what a kids profile hides, on this device, for minutes.
// The server opens it (parent:unlock) for this connection only and says until when; the device saves it as
// { profile, until } just to ask for the rest again when it connects anew. until is 0 while it's shut (the
// device still remembers it's a kids profile, so its controls stay hidden while the page loads).
export const LOCK = { key: "hometube:parent-lock", minutes: 15, holdMs: 3000 };

const MINUTE = 60 * 1000;

// how long the parent lock stays open for this profile, in ms; 0 when shut, and never more than LOCK.minutes
// (a clock set back, or a value typed in by hand, can't keep it open longer)
export const lockLeft = (lock, profile, now) => {
  if (!lock || !profile || lock.profile !== profile) return 0;
  const left = Number(lock.until) - now;
  return left > 0 && left <= LOCK.minutes * MINUTE ? left : 0;
};

// The modes a page can be in; on a kids profile <html data-kids> carries the kind.
const MODES = { off: { kind: "" }, grownup: { kind: "grownup" }, locked: { kind: "locked" }, unlocked: { kind: "unlocked" } };

// The page's mode: "" (no kids profiles on this server, or not known yet), "grownup", "locked" or "unlocked".
// state: the server's `profiles` message (null until it comes); saved: this device's profile id. Before the
// message comes, a device that last watched as a kids profile stays as it was. A server that doesn't offer
// the parent lock (no parentLock in its message) keeps a kids profile locked.
export const kidsMode = (state, lock, now, saved) => {
  const kids = (profile, offered) => (offered && lockLeft(lock, profile, now) ? MODES.unlocked : MODES.locked).kind;
  if (!state) return lock && saved && lock.profile === saved ? kids(saved, true) : MODES.off.kind;
  const current = state.current;
  if (typeof current?.kid !== "boolean") return MODES.off.kind;
  return current.kid ? kids(current.id, state.parentLock === true) : MODES.grownup.kind;
};

// When a lock the server just opened shuts, on this device's clock. until: the server's answer (on its own
// clock), sentAt: when it was asked, asked: for how long (ms). A server clock that disagrees with this
// device's (until already past, or further off than asked for) counts from sentAt instead. 0: not open.
export const unlockedUntil = (until, sentAt, asked, now) => {
  const at = Number(until);
  if (!(at > 0)) return 0;
  const left = at - now;
  return left > 0 && left <= asked ? at : sentAt + asked;
};

// what a hidden control's root gets: null hides it; with kids profiles off it renders exactly as before
export const grownUpProps = (mode, name) => {
  if (mode === "locked") return null;
  return mode === "" ? {} : { "data-grownup": name };
};

// whole minutes left, as the top bar shows them: 14:01 left is "15 min", 0:20 is "1 min"
export const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / MINUTE));

// The parent lock's question for a TV remote that can't hold a button: two two-digit numbers whose sum has
// two digits and no carrying, so a grown-up answers at a glance and a small child can't. rand: () => [0, 1).
export const question = (rand = Math.random) => {
  const pick = (from, to) => from + Math.floor(rand() * (to - from + 1));
  const units = pick(1, 8);
  const a = pick(1, 5) * 10 + units;
  const b = pick(1, 3) * 10 + pick(1, 9 - units);
  return { a, b, sum: a + b };
};

const storageOf = (storage) => {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    // storage turned off in the browser
    return null;
  }
};

export const readLock = (storage) => {
  try {
    const raw = storageOf(storage)?.getItem(LOCK.key);
    const lock = raw ? JSON.parse(raw) : null;
    return lock && typeof lock.profile === "string" ? { profile: lock.profile, until: Number(lock.until) || 0 } : null;
  } catch {
    return null;
  }
};

export const saveLock = (lock, storage) => {
  try {
    storageOf(storage)?.setItem(LOCK.key, JSON.stringify(lock));
  } catch {
    // private mode: the lock lasts until the page is closed
  }
};

export const dropLock = (storage) => {
  try {
    const s = storageOf(storage);
    if (s && s.getItem(LOCK.key) !== null) s.removeItem(LOCK.key);
  } catch {
    // nothing saved
  }
};
