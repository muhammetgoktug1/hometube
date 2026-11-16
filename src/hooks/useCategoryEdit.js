import { useEffect } from "react";

// Store
import useCategoryEditStore from "@/store/useCategoryEditStore";

// Utils
import { getSocket } from "@/utils/socket";

// The server sends `categories:edit` on every connection while HOMETUBE_CATEGORY_EDIT is on; until then the watch
// page shows its category list box.

// the notice comes right after a connection; a connection without it in this time (a server started again without
// the flag) turns the picker off
const QUIET_MS = 3000;

let bound = false;

// Listens once per page load (AppShell, on every page, so the notice of the first connection is never missed by a
// watch page opened later).
const bind = () => {
  if (bound) return;
  bound = true;

  const socket = getSocket();
  const { setOn } = useCategoryEditStore.getState();
  let quiet;
  socket.on("connect", () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => setOn(false), QUIET_MS);
  });
  socket.on("categories:edit", () => {
    clearTimeout(quiet);
    setOn(true);
  });
};

const useCategoryEdit = () => {
  useEffect(bind, []);
};

export default useCategoryEdit;
