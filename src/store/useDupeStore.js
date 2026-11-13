import { create } from "zustand";

// The duplicate check's answer for this profile's library, kept by useDupes; empty while the check is off.
// status: "idle" until the server answers (it never does without HOMETUBE_DUPES), then "on".
// only: the home page shows just the videos that share content with another (the Duplicates chip).
const useDupeStore = create((set) => ({
  status: "idle",
  videos: {},
  only: false,

  setDupes: (videos) => set({ status: "on", videos }),
  clear: () => set({ status: "idle", videos: {}, only: false }),
  setOnly: (only) => set({ only }),
}));

export default useDupeStore;
