"use client";

// Components
import PlaylistImport from "@/components/PlaylistImport";
import { useProfileGate } from "@/components/ProfileGate";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

// Hooks
import useDupes from "@/hooks/useDupes";
import useKidsShell from "@/hooks/useKids";
import useLibrarySync from "@/hooks/useLibrarySync";
import usePlaylists from "@/hooks/usePlaylists";

// Store
import usePlaylistStore from "@/store/usePlaylistStore";
import useUiStore from "@/store/useUiStore";

// Styles
import Styles from "./styles.module.scss";

// Top bar, sidebar and the page; also keeps the library in sync with the server.
// theater: the page runs edge to edge and the sidebar only opens as an overlay, like a cinema view.
const AppShell = ({ children, theater }) => {
  useLibrarySync();
  useDupes();
  usePlaylists();
  // kids profiles: the parent lock and <html data-kids>; nothing without them
  useKidsShell();
  const sidebarToggled = useUiStore((state) => state.sidebarToggled);
  // the playlist picker exists only once the server has said it offers playlists
  const playlists = usePlaylistStore((state) => state.on);
  // while profiles are on, the profile screen stands in for everything until this device picks one
  const gate = useProfileGate();
  if (gate) return gate;

  return (
    <div className={Styles.shell} data-toggled={sidebarToggled} data-theater={!!theater}>
      <TopBar />
      <Sidebar overlay={theater} />
      <main className={Styles.main}>{children}</main>
      {playlists && <PlaylistImport />}
    </div>
  );
};

export default AppShell;
