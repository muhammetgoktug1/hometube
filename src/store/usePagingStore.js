import { create } from "zustand";

// Paging (src/utils/homeFeed.js), kept by usePaging.
// on: this connection heard `paging:on`; the server never says it while HOMETUBE_PAGING is off, so then every grid
// draws all its cards, as before.
const usePagingStore = create((set) => ({
  on: false,

  setOn: (on) => set({ on }),
}));

export default usePagingStore;
