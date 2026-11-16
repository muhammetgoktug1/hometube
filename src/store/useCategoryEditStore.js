import { create } from "zustand";

// Category editing on the watch page (src/components/CategoryPicker), kept by useCategoryEdit.
// on: this connection heard `categories:edit`; the server never says it while HOMETUBE_CATEGORY_EDIT is off, so
// then the watch page keeps its category list box, as before.
const useCategoryEditStore = create((set) => ({
  on: false,

  setOn: (on) => set({ on }),
}));

export default useCategoryEditStore;
