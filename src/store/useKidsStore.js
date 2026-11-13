import { create } from "zustand";

// Utils
import { LOCK, dropLock, lockLeft, readLock, saveLock, unlockedUntil } from "@/utils/kids";
import { getSocket } from "@/utils/socket";

// how long the server has to answer parent:unlock
const ANSWER_MS = 5000;
// what the parent lock's row says when it didn't
export const NO_ANSWER = "HomeTube didn't answer. Try again.";

// the connection that already asked to go on with this device's open lock
let resumed = "";

// Asks the server to open the parent lock for this connection (data: parent:unlock's, asked: for how long, ms)
// and saves when it shuts. Resolves "" once it's open, else the server's error: the lock stays shut.
const ask = (set, profile, data, asked) =>
  new Promise((resolve) => {
    const sentAt = Date.now();
    getSocket()
      .timeout(ANSWER_MS)
      .emit("parent:unlock", data, (err, res) => {
        const until = err || res?.error ? 0 : unlockedUntil(res?.until, sentAt, asked, Date.now());
        const lock = { profile, until };
        saveLock(lock);
        set({ lock });
        resolve(until ? "" : (!err && res?.error) || NO_ANSWER);
      });
  });

// The parent lock on this device (see LOCK in utils/kids). It's read once a page shows and only written after
// the server has said the profile on this device is a kids profile, so without kids profiles nothing is ever
// saved or sent. The server decides: the lock opens when it says so, for as long as it says.
const useKidsStore = create((set, get) => ({
  lock: null,
  loaded: false,

  load: () => {
    if (!get().loaded) set({ lock: readLock(), loaded: true });
  },

  // the server says this device's profile is a kids profile: remember it (an open lock for it stays open)
  remember: (profile) => {
    if (get().lock?.profile === profile) return;
    const lock = { profile, until: 0 };
    saveLock(lock);
    set({ lock });
  },

  // held long enough, or the sum answered: resolves "" once the server has opened it, else its error
  unlock: (id) => {
    const profile = id || get().lock?.profile;
    if (!profile) return Promise.resolve(NO_ANSWER);
    return ask(set, profile, {}, LOCK.minutes * 60 * 1000);
  },

  // A new connection starts locked on the server: once per connection, a device whose lock is still open asks
  // for the minutes it has left.
  resume: (profile) => {
    const connection = getSocket().id;
    if (!connection || resumed === connection) return;
    resumed = connection;
    const left = lockLeft(get().lock, profile, Date.now());
    if (left) ask(set, profile, { resume: true, left }, left);
  },

  // Lock, or its time is up: shut here and on the server
  relock: () => {
    const { lock } = get();
    if (!lock?.until) return;
    getSocket().emit("parent:lock", {});
    const shut = { profile: lock.profile, until: 0 };
    saveLock(shut);
    set({ lock: shut });
  },

  // another profile, a grown-up one, or kids profiles turned off: nothing to remember
  forget: () => {
    if (!get().lock) return;
    dropLock();
    set({ lock: null });
  },
}));

export default useKidsStore;
