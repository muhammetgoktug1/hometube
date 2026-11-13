"use client";

import { useState } from "react";

// Components
import AddVideoDialog from "@/components/AddVideoDialog";
import AppShell from "@/components/AppShell";
import GrownUp from "@/components/GrownUp";
import { LogoMark } from "@/components/Logo";
import VideoGrid from "@/components/VideoGrid";

// Partials
import CategoryChips from "./partials/CategoryChips";

// Hooks
import { useKids } from "@/hooks/useKids";

// Store
import useDupeStore from "@/store/useDupeStore";
import useLibraryStore from "@/store/useLibraryStore";
import useUiStore from "@/store/useUiStore";

// Utils
import { groupOrder, warns } from "@/utils/dupes";
import { mixFeed } from "@/utils/feed";
import { matches } from "@/utils/shortcuts";

// Styles
import Styles from "./styles.module.scss";

const Home = () => {
  const { videos, channels, loaded } = useLibraryStore();
  const { query, category } = useUiStore();
  const kids = useKids();
  // picked once per visit: "All" is mixed differently each time you come back, but holds still meanwhile
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 32));
  const channelName = (id) => channels.find((c) => c.id === id)?.name || "";
  // the Duplicates chip: only videos whose content is also in another one, related ones side by side
  const { only, videos: dupes } = useDupeStore();
  // Shorts live in the Shorts player
  const found = videos.filter((v) => !v.short && (!category || v.category === category) && matches(v, channelName(v.channel), query) && (!only || warns(dupes[v.id])));
  // categories and search results stay newest first, as the server sends them
  const shown = only ? groupOrder(found, dupes) : !category && !query.trim() ? mixFeed(found, seed) : found;

  return (
    <AppShell>
      <CategoryChips />

      {loaded && !videos.length && (
        <div className={Styles.empty}>
          <LogoMark size={72} />
          {kids === "locked" ? (
            <>
              <h2>Nothing to watch here yet</h2>
              <p>A grown-up can add videos to this profile with the parent lock in the profile menu.</p>
            </>
          ) : (
            <>
              <h2>Your library is empty</h2>
              <p>Paste a YouTube link and HomeTube downloads the video to your server, so you can watch it any time, even offline.</p>
            </>
          )}
          <GrownUp name="add">
            <AddVideoDialog label="Add your first video" primary />
          </GrownUp>
        </div>
      )}

      {!!videos.length && !shown.length && (
        <p className={Styles.none}>{query ? `Nothing in your library matches "${query}".` : "No videos in this category yet."}</p>
      )}

      <VideoGrid videos={shown} />
    </AppShell>
  );
};

export default Home;
