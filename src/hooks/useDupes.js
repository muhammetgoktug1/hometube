import { useEffect } from "react";

// Store
import useDupeStore from "@/store/useDupeStore";

// Utils
import { savedProfile } from "@/utils/profile";
import { getSocket } from "@/utils/socket";

// The server sends `dupes:on` on every connection while HOMETUBE_DUPES is on, and again once what it
// found changed (lib/dupes.js); without it nothing here ever asks.

// an answer that takes longer is given up on; the next notice asks again
const WAIT_MS = 15_000;
// a changed library (a video removed, or added to the profile) is asked about again, at most this often
const AGAIN_MS = 30_000;

let bound = false;

// Wires the duplicate check into useDupeStore once per page load (AppShell, on every page, so the
// notice of the first connection is never missed); later calls do nothing.
const bind = () => {
  if (bound) return;
  bound = true;

  const socket = getSocket();
  const { setDupes, clear } = useDupeStore.getState();
  // the profile the answer kept is for ("" without profiles), and whether one is on its way
  let owner = "";
  let asking = false;
  let again = false;
  let timer;

  const ask = () => {
    if (!socket.connected) return;
    if (asking) return void (again = true);
    asking = true;
    const who = savedProfile();
    socket.timeout(WAIT_MS).emit("dupes", (err, res) => {
      asking = false;
      // "Pick a profile first." until this device picks one; picking one connects again
      if (!err && res && !res.error && res.videos && who === savedProfile()) {
        owner = who;
        setDupes(res.videos);
      }
      if (again) {
        again = false;
        ask();
      }
    });
  };
  const later = () => {
    if (useDupeStore.getState().status !== "on" || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      ask();
    }, AGAIN_MS);
  };

  // watching as another profile: what was found for the last one goes before anything is shown
  socket.on("connect", () => savedProfile() !== owner && clear());
  socket.on("dupes:on", ask);
  socket.on("library", later);
};

const useDupes = () => {
  useEffect(bind, []);
};

export default useDupes;
