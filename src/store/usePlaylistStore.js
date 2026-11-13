import { create } from "zustand";

// Adding a playlist's videos (lib/playlists.js), kept by usePlaylists.
// on: this connection heard `playlists:on`; the server never says it while HOMETUBE_PLAYLISTS is off, so then
// the add dialog stays as it is and nothing here is shown or asked.
// answer: the playlist:browse answer the picker (PlaylistImport) shows; category: the add dialog's pick, carried over.
// result: what the last download queued, shown for a moment once the picker has closed.
// seq: counts the answers shown, so the picker starts afresh for each.
const usePlaylistStore = create((set) => ({
  on: false,
  answer: null,
  category: "",
  result: null,
  seq: 0,

  setOn: (on) => set({ on }),
  show: (answer, category = "") => set((state) => ({ answer, category, result: null, seq: state.seq + 1 })),
  hide: () => set({ answer: null }),
  done: (result) => set({ answer: null, result }),
  clearResult: () => set({ result: null }),
}));

export default usePlaylistStore;
