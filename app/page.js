"use client";

import { useState } from "react";

// Components
import AddVideoDialog from "@/components/AddVideoDialog";
import AppShell from "@/components/AppShell";
import { LogoMark } from "@/components/Logo";
import VideoGrid from "@/components/VideoGrid";

// Partials
import CategoryChips from "./partials/CategoryChips";

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
          <h2>Your library is empty</h2>
          <p>Paste a YouTube link and HomeTube downloads the video to your server, so you can watch it any time, even offline.</p>
          <AddVideoDialog label="Add your first video" primary />
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
