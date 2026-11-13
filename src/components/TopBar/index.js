"use client";

import { usePathname, useRouter } from "next/navigation";

// Components
import AddVideoDialog from "@/components/AddVideoDialog";
import GrownUp from "@/components/GrownUp";
import Icon from "@/components/Icon";
import { LockPill, useKidsBar } from "@/components/Kids";
import Logo from "@/components/Logo";
import ProfileSwitch from "@/components/ProfileSwitch";

// Store
import useLibraryStore from "@/store/useLibraryStore";
import useUiStore from "@/store/useUiStore";

// Utils
import { fmtBytes, fmtLength } from "@/utils/shortcuts";

// Styles
import Styles from "./styles.module.scss";

// a class name, and another one only when there is one (without kids profiles the bar renders exactly as before)
const also = (name, more) => (more ? `${name} ${more}` : name);

const TopBar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { videos, connected } = useLibraryStore();
  const ready = videos.filter((v) => v.status === "ready");
  const size = ready.reduce((a, v) => a + v.size, 0);
  const length = ready.reduce((a, v) => a + v.duration, 0);
  const { query, setQuery, toggleSidebar } = useUiStore();
  // kids profiles on: the end keeps one width, so the search box stays put whatever the parent lock does
  const kids = useKidsBar();

  // the search filters the home grid, so searching from another page goes home
  const search = (e) => {
    e.preventDefault();
    if (pathname !== "/") router.push("/");
  };

  return (
    <header className={also(Styles.bar, kids.bar)}>
      <div className={Styles.start}>
        <button type="button" className={Styles.iconButton} onClick={toggleSidebar} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <Logo />
      </div>

      <form className={Styles.search} onSubmit={search} role="search">
        <input type="search" placeholder="Search your library" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        <button aria-label="Search">
          <Icon name="search" size={22} />
        </button>
      </form>

      <div className={also(Styles.end, kids.end)}>
        {!!ready.length && (
          <span className={also(Styles.stats, kids.stats)} title="Downloaded to your server">
            {ready.length} {ready.length === 1 ? "video" : "videos"} · {fmtBytes(size)} · {fmtLength(length)}
          </span>
        )}
        <span className={Styles.status} data-connected={connected} title={connected ? "Connected to your server" : "Reconnecting…"} />
        <LockPill />
        <ProfileSwitch />
        <GrownUp name="add">
          <AddVideoDialog />
        </GrownUp>
      </div>
    </header>
  );
};

export default TopBar;
