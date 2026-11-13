import { useEffect } from "react";

// Store
import usePlaylistStore from "@/store/usePlaylistStore";

// Utils
import { getSocket } from "@/utils/socket";

// The server sends `playlists:on` on every connection while HOMETUBE_PLAYLISTS is on (with profiles on, once this
// device has picked one; picking one connects again). Until then the add dialog stays as it is and no playlist
// event is ever sent.

// the notice comes right after a connection; a connection without it in this time (a server started again
// without the flag) turns playlists off. Waiting instead of turning them off at once keeps an open picker
// through a short drop of the connection.
const QUIET_MS = 3000;

let bound = false;

// Listens once per page load (AppShell, on every page, so the notice of the first connection is never missed);
// later calls do nothing.
const bind = () => {
  if (bound) return;
  bound = true;

  const socket = getSocket();
  const { setOn } = usePlaylistStore.getState();
  let quiet;
  socket.on("connect", () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => setOn(false), QUIET_MS);
  });
  socket.on("playlists:on", () => {
    clearTimeout(quiet);
    setOn(true);
  });
};

const usePlaylists = () => {
  useEffect(bind, []);
};

export default usePlaylists;
