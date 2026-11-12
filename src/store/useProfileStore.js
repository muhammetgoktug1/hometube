import { create } from "zustand";

// Store
import useLibraryStore from "@/store/useLibraryStore";
import useUiStore from "@/store/useUiStore";

// Utils
import { forgetProfile, rememberProfile } from "@/utils/profile";
import { getSocket } from "@/utils/socket";

let bound = false;
// a profile this device deleted itself: its going needs no notice here
let leaving = "";

// Profiles as the server last sent them (HOMETUBE_PROFILES=1). `state` stays null until a `profiles`
// message comes, so without profiles nothing changes anywhere. notice: this device's profile was removed.
const useProfileStore = create((set, get) => ({
  state: null,
  notice: false,

  // Watch as another profile: remembered on this device, then the connection starts over with it
  // and the library loads again, without reloading the page.
  pick: (profile) => {
    const { id, name, color } = profile;
    rememberProfile(id);
    useLibraryStore.setState({ videos: [], channels: [], categories: [], loaded: false });
    useUiStore.setState({ category: "", query: "" });
    set((s) => ({ state: { ...s.state, current: { id, name, color }, reason: undefined }, notice: false }));
    getSocket().disconnect().connect();
  },

  // these answer with the server's error, or "" once done
  add: (name, color) =>
    new Promise((resolve) => {
      getSocket().emit("profile:create", { name, color }, (res) => {
        if (res?.error) return resolve(res.error);
        get().pick(res);
        resolve("");
      });
    }),

  update: (id, change) =>
    new Promise((resolve) => {
      getSocket().emit("profile:update", { id, ...change }, (res) => resolve(res?.error || ""));
    }),

  remove: (id) =>
    new Promise((resolve) => {
      if (get().state?.current?.id === id) leaving = id;
      getSocket().emit("profile:delete", { id }, (res) => {
        if (res?.error) leaving = "";
        resolve(res?.error || "");
      });
    }),

  // the videos no profile has, to one profile: { moved, … } or { error }
  claim: (profile, expect, categories) =>
    new Promise((resolve) => {
      getSocket().emit("profile:claim", { profile, expect, categories }, (res) => resolve(res || {}));
    }),
}));

// Listens for the server's `profiles` message once per page load (see useProfileGate).
export const bindProfiles = () => {
  if (bound) return;
  bound = true;
  getSocket().on("profiles", (state) => {
    const removed = state?.reason === "removed";
    if (removed) forgetProfile();
    const quiet = removed && !!leaving;
    if (removed) leaving = "";
    useProfileStore.setState((s) => ({ state, notice: state?.current ? false : removed ? !quiet : s.notice }));
  });
};

export default useProfileStore;
