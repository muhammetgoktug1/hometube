import { useEffect, useState } from "react";

// Store
import usePagingStore from "@/store/usePagingStore";

// Utils
import { getSocket } from "@/utils/socket";

// The server sends `paging:on` on every connection while HOMETUBE_PAGING is on; until then the grids draw every card.

// the notice comes right after a connection; a connection without it in this time (a server started again without
// the flag) turns paging off
const QUIET_MS = 3000;

let bound = false;

// Listens once per page load (AppShell, on every page, so the notice of the first connection is never missed).
const bind = () => {
  if (bound) return;
  bound = true;

  const socket = getSocket();
  const { setOn } = usePagingStore.getState();
  let quiet;
  socket.on("connect", () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => setOn(false), QUIET_MS);
  });
  socket.on("paging:on", () => {
    clearTimeout(quiet);
    setOn(true);
  });
};

const usePaging = () => {
  useEffect(bind, []);
};

// How many times "Show more" was pressed in the view called view; it starts again at 0 when the view changes
// (another category, search, tab or channel).
export const useMore = (view) => {
  const [more, setMore] = useState({ view, n: 0 });
  const n = more.view === view ? more.n : 0;
  return [n, () => setMore({ view, n: n + 1 })];
};

export default usePaging;
