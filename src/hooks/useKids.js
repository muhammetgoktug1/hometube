import { useEffect, useLayoutEffect } from "react";

// Store
import useKidsStore from "@/store/useKidsStore";
import useProfileStore from "@/store/useProfileStore";

// Utils
import { grownUpProps, kidsMode, lockLeft } from "@/utils/kids";
import { savedProfile } from "@/utils/profile";

// The page's kids mode: "" (no kids profiles), "grownup", "locked" or "unlocked" (see kidsMode).
export const useKids = () => {
  const state = useProfileStore((s) => s.state);
  const lock = useKidsStore((s) => s.lock);
  return kidsMode(state, lock, Date.now(), lock ? savedProfile() : "");
};

// For a control a kids profile doesn't get: null while a kids profile is locked (render nothing), else the
// props for its root ({ "data-grownup": name } while kids profiles are on, {} without them).
export const useGrownUp = (name) => grownUpProps(useKids(), name);

// For AppShell, once per page: loads the parent lock saved on this device, keeps it in step with the server's
// profiles, asks a new connection's server to go on with a lock still open here, shuts it when its time is up
// and marks <html data-kids="locked|unlocked"> on a kids profile. Without kids profiles it only reads that
// nothing is saved.
const useKidsShell = () => {
  const state = useProfileStore((s) => s.state);
  const { lock, load, remember, resume, relock, forget } = useKidsStore();
  const mode = useKids();

  // before the first paint, so a kids profile's controls don't flash while the page loads
  useLayoutEffect(load, []);

  useEffect(() => {
    if (!state) return;
    if (state.current?.kid === true) remember(state.current.id);
    else forget();
    // every connection sends its profiles first: that's when the server can take the rest of an open lock
    if (state.current?.kid === true && state.parentLock === true) resume(state.current.id);
  }, [state]);

  useEffect(() => {
    if (mode !== "unlocked") return;
    const timer = setTimeout(relock, lockLeft(lock, lock.profile, Date.now()));
    return () => clearTimeout(timer);
  }, [mode, lock]);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "locked" || mode === "unlocked") root.dataset.kids = mode;
    else if (root.dataset.kids !== undefined) delete root.dataset.kids;
  }, [mode]);
};

export default useKidsShell;
