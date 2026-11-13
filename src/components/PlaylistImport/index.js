"use client";

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

// Components
import Icon from "@/components/Icon";

// Store
import useLibraryStore from "@/store/useLibraryStore";
import usePlaylistStore from "@/store/usePlaylistStore";

// Utils
import { asksFirst, confirmLine, inFilter, isFresh, resultLine } from "@/utils/playlistLink";
import { bytesPerSecond, fmtBytes, fmtDuration, fmtLength } from "@/utils/shortcuts";
import { getSocket } from "@/utils/socket";

// Styles
import DialogStyles from "@/styles/dialog.module.scss";
import Styles from "./styles.module.scss";

const FILTERS = [
  ["new", "Not saved yet"],
  ["saved", "Already saved"],
  ["all", "Everything"],
];

// how long the picker ignores its download button after opening (and the question before a big download, its
// own buttons after it shows up): a held OK on the remote repeats
const SETTLE_MS = 400;
// how long the line about what was queued stays
const RESULT_MS = 8000;

const buttonLabel = (busy, n) => {
  if (busy) return "Adding…";
  if (!n) return "Download";
  return n === 1 ? `Download the ${n} picked video` : `Download the ${n} picked videos`;
};

const summary = (n, seconds) => {
  if (!n) return "Nothing picked yet";
  return n === 1 ? `${n} video picked · ${fmtLength(seconds)}` : `${n} videos picked · ${fmtLength(seconds)}`;
};

// ---- the remote's arrows: left and right within a group (header, filters, footer), up and down between the
// groups and through the rows. Tab goes on working as everywhere else.
const ARROWS = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 };
const focusables = (el) => [...el.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
// a row's checkbox sits right in its <label>
const rowOf = (el) => el.parentElement;

// where focus lands when it comes into a group: in the list the first (or last) row in sight, elsewhere the
// group's own pick (the shown filter, the download button)
const entry = (zone, step) => {
  const items = focusables(zone);
  if (!items.length) return null;
  if (zone.dataset.zone === "list") {
    const box = zone.getBoundingClientRect();
    const seen = items.filter((el) => {
      const r = rowOf(el).getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    });
    const pool = seen.length ? seen : items;
    return step > 0 ? pool[0] : pool[pool.length - 1];
  }
  return zone.querySelector("[data-entry]:not(:disabled)") || items[0];
};

const onArrow = (e) => {
  const step = ARROWS[e.key];
  if (!step || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = document.activeElement;
  // while the picker asks before a big download, only its question takes focus
  const zones = [...e.currentTarget.querySelectorAll(":scope > [data-zone]")].filter((z) => !z.inert);
  const zone = zones.find((z) => z.contains(el));
  if (!zone) return;
  const vertical = e.key === "ArrowUp" || e.key === "ArrowDown";
  // a closed list box changes its value with up and down
  if (vertical && el.tagName === "SELECT") return;
  let next = null;
  if (!vertical) {
    if (zone.dataset.zone === "list") return;
    const items = focusables(zone);
    next = items[items.indexOf(el) + step];
  } else {
    if (zone.dataset.zone === "list") {
      const items = focusables(zone);
      next = items[items.indexOf(el) + step];
    }
    for (let i = zones.indexOf(zone) + step; !next && zones[i]; i += step) next = entry(zones[i], step);
  }
  if (!next) return;
  e.preventDefault();
  next.focus({ preventScroll: true });
  if (e.currentTarget.querySelector(":scope > [data-zone=list]")?.contains(next)) rowOf(next).scrollIntoView({ block: "nearest" });
};

// Enter (the remote's OK) on a checkbox would send the form; here it ticks the box like Space
const enterTicks = (toggle) => (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  toggle();
};

// One video of the playlist. Saved and unavailable ones show why they can't be picked and take no focus.
const Row = memo(function Row({ v, picked, estimate, onToggle }) {
  const fresh = isFresh(v);
  // private or removed: YouTube no longer says what it was
  const gone = !v.saved && v.unavailable && !v.membersOnly;
  const toggle = () => onToggle(v.ytId);
  return (
    <li>
      <label
        className={Styles.row}
        data-playlist-row
        data-video={v.ytId}
        data-state={v.saved ? "saved" : v.unavailable ? "unavailable" : "fresh"}
        data-picked={picked || undefined}
      >
        {fresh ? (
          <input type="checkbox" checked={picked} onChange={toggle} onKeyDown={enterTicks(toggle)} />
        ) : (
          <span className={Styles.mark} aria-hidden="true">
            <Icon name={v.saved ? "check" : "blocked"} size={20} />
          </span>
        )}
        <span className={Styles.thumb}>
          {gone ? <Icon name="blocked" size={28} /> : <img src={v.thumbnail} alt="" loading="lazy" decoding="async" />}
          {!!v.duration && <small>{fmtDuration(v.duration)}</small>}
        </span>
        <span className={Styles.body}>
          {gone ? <span className={Styles.gone}>Private or removed video</span> : <span className={Styles.importTitle}>{v.title}</span>}
          <span className={Styles.meta}>
            {!!v.channel.name && <span className={Styles.importTitleChannel}>{v.channel.name}</span>}
            {v.short && (
              <span className={Styles.short}>
                <Icon name="shorts" size={14} /> Shorts
              </span>
            )}
            {v.saved && <em>In library</em>}
            {!v.saved && v.unavailable && <em>{v.membersOnly ? "Members only" : "Can't be downloaded"}</em>}
            {fresh && !!estimate && <small className={Styles.size}>≈ {fmtBytes(estimate)}</small>}
          </span>
        </span>
      </label>
    </li>
  );
});

// The picker's content for one playlist:browse answer: mounted afresh for each, so the picks start from the
// answer (every video that isn't saved and can be downloaded).
const Picker = ({ answer, carried, titleId, close, done }) => {
  const { categories, videos: library } = useLibraryStore();
  const { playlist, videos, truncated, hidden, limit, total } = answer;
  const fresh = useMemo(() => videos.filter(isFresh), [videos]);
  const [picked, setPicked] = useState(() => new Set(fresh.map((v) => v.ytId)));
  // the whole playlist in its order, the saved ones marked: what the add dialog promised
  const [filter, setFilter] = useState("all");
  const [category, setCategory] = useState(carried);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // many videos picked: the download button asks once more, here in the picker, before anything is queued
  const [asking, setAsking] = useState(false);
  const primary = useRef();
  const cancel = useRef();
  const back = useRef();
  const opened = useRef(0);
  const asked = useRef(0);

  const count = useMemo(
    () => Object.fromEntries(FILTERS.map(([key]) => [key, videos.filter((v) => inFilter(key, v)).length])),
    [videos],
  );
  const shown = useMemo(() => videos.filter((v) => inFilter(filter, v)), [videos, filter]);
  // YouTube's listing has no file sizes, so estimate them from the library's average bitrate (as Get videos does)
  const rate = useMemo(() => bytesPerSecond(library), [library]);
  const chosen = fresh.filter((v) => picked.has(v.ytId));
  const seconds = chosen.reduce((a, v) => a + v.duration, 0);
  const allPicked = !!fresh.length && chosen.length === fresh.length;

  const toggle = useCallback(
    (ytId) =>
      setPicked((was) => {
        const next = new Set(was);
        if (next.has(ytId)) next.delete(ytId);
        else next.add(ytId);
        return next;
      }),
    [],
  );
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(fresh.map((v) => v.ytId)));

  // the remote's OK goes to the download button, the usual next step; nothing is queued until it's pressed
  useEffect(() => {
    opened.current = performance.now();
    (primary.current?.disabled ? cancel.current : primary.current)?.focus();
  }, []);

  // the question opens on its Cancel, so a second OK doesn't start a big download; going back, on the download button
  useEffect(() => {
    if (asking) back.current?.focus();
    else if (asked.current) primary.current?.focus();
  }, [asking]);

  const stopAsking = () => {
    if (performance.now() - asked.current < SETTLE_MS) return;
    setAsking(false);
  };

  const submit = (e) => {
    e.preventDefault();
    const now = performance.now();
    if (busy || !chosen.length || now - opened.current < SETTLE_MS) return;
    if (!asking && asksFirst(chosen.length)) {
      asked.current = now;
      return setAsking(true);
    }
    if (asking && now - asked.current < SETTLE_MS) return;
    setBusy(true);
    setError("");
    const ids = chosen.map((v) => v.ytId);
    getSocket().emit("playlist:download", { list: playlist.id, videos: ids, category }, (res) => {
      setBusy(false);
      if (res.error) {
        setAsking(false);
        return setError(res.error);
      }
      done({ queued: res.queued, linked: res.linked || 0, saved: res.saved, unavailable: res.unavailable });
    });
  };

  const keys = (e) => {
    if (e.key === "Enter" && e.repeat) e.preventDefault();
    onArrow(e);
  };

  return (
    <form className={`${DialogStyles.sheet} ${Styles.sheet}`} onSubmit={submit} onKeyDown={keys}>
      <header className={DialogStyles.head} data-zone="head" inert={asking || undefined}>
        <div className={Styles.heading}>
          <h2 id={titleId}>Playlist: {playlist.title}</h2>
          {!!playlist.channel && <p className={Styles.importTitleOwner}>{playlist.channel}</p>}
        </div>
        <button type="button" className={DialogStyles.close} onClick={close} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
      </header>

      {(truncated || hidden > 0) && (
        <div className={Styles.notices}>
          {truncated && (
            <p className={Styles.notice} data-playlist-notice data-kind="truncated">
              <Icon name="info" size={18} /> {`Showing the first ${limit} videos (${total} in the playlist)`}
            </p>
          )}
          {hidden > 0 && (
            <p className={Styles.notice} data-playlist-notice data-kind="hidden">
              <Icon name="info" size={18} />{" "}
              {hidden === 1 ? `${hidden} live or upcoming video isn't listed` : `${hidden} live or upcoming videos aren't listed`}
            </p>
          )}
        </div>
      )}

      <div className={Styles.bar} data-zone="bar" inert={asking || undefined}>
        <div className={Styles.filters} role="tablist" aria-label="Show">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              // nothing to show: the remote skips it instead of opening an empty list
              disabled={!count[key] && filter !== key}
              data-entry={filter === key || undefined}
              onClick={() => setFilter(key)}
              data-playlist-filter
              data-filter={key}
            >
              {label} <small>{count[key]}</small>
            </button>
          ))}
        </div>
        {!!fresh.length && (
          <label className={Styles.all}>
            <input type="checkbox" checked={allPicked} onChange={toggleAll} onKeyDown={enterTicks(toggleAll)} /> Pick all not saved yet
          </label>
        )}
      </div>

      <ul className={Styles.list} data-zone="list" inert={asking || undefined}>
        {shown.map((v) => (
          <Row key={v.ytId} v={v} picked={picked.has(v.ytId)} estimate={v.duration * rate} onToggle={toggle} />
        ))}
        {!shown.length && <li className={Styles.empty}>Nothing here.</li>}
      </ul>

      {error && (
        <p className={Styles.failed} role="alert" data-playlist-notice data-kind="error">
          {error}
        </p>
      )}

      {asking ? (
        <footer key="ask" className={`${DialogStyles.foot} ${Styles.foot} ${Styles.confirm}`} data-zone="foot" data-playlist-confirm>
          <p className={Styles.question}>{confirmLine(chosen.length, seconds, seconds * rate)}</p>
          <span className={Styles.buttons}>
            <button ref={back} type="button" className="btn" onClick={stopAsking}>
              Cancel
            </button>
            <button className="btnBrand" disabled={busy} data-playlist-start>
              {busy ? "Adding…" : "Start downloading"}
            </button>
          </span>
        </footer>
      ) : (
        <footer key="picks" className={`${DialogStyles.foot} ${Styles.foot}`} data-zone="foot">
          {!!categories.length && (
            <select className={Styles.category} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <p className={Styles.count} data-playlist-count>
            <span>{summary(chosen.length, seconds)}</span>
            {!!seconds && (
              <span className={Styles.total} title="Estimated from the average size of your downloaded videos">
                ≈ {fmtBytes(seconds * rate)}
              </span>
            )}
          </p>
          <span className={Styles.buttons}>
            <button ref={cancel} type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button ref={primary} className="btnBrand" disabled={busy || !chosen.length} data-entry data-playlist-download>
              {buttonLabel(busy, chosen.length)}
            </button>
          </span>
        </footer>
      )}
    </form>
  );
};

// A short line once the picker has closed: how many videos went into the download queue and, apart, how many
// were only added because another profile had downloaded them already.
const Result = ({ result, onDone }) => {
  useEffect(() => {
    const timer = setTimeout(onDone, RESULT_MS);
    return () => clearTimeout(timer);
  }, [result, onDone]);
  return (
    <p className={Styles.result} role="status" data-playlist-result>
      <Icon name="check" size={20} />
      <span>{resultLine(result)}</span>
    </p>
  );
};

// The playlist picker, a sibling of the channel's Get videos dialog: the add dialog opens it with a playlist:browse
// answer (usePlaylistStore.show); the picked videos are queued with playlist:download. Mounted by AppShell only
// while the server offers playlists.
const PlaylistImport = () => {
  const { answer, seq, category, result, hide, done, clearResult } = usePlaylistStore();
  const dialog = useRef();
  const titleId = useId();

  // before the picker's own effect, which moves focus to its download button
  useLayoutEffect(() => {
    const el = dialog.current;
    if (answer && !el.open) el.showModal();
    if (!answer && el.open) el.close();
  }, [answer]);

  const close = () => dialog.current.close();

  return (
    <>
      <dialog
        ref={dialog}
        className={`${DialogStyles.dialog} ${Styles.dialog}`}
        aria-labelledby={titleId}
        onClose={hide}
        onClick={(e) => e.target === dialog.current && close()}
        data-playlist-import
      >
        {answer && <Picker key={seq} answer={answer} carried={category} titleId={titleId} close={close} done={done} />}
      </dialog>
      {result && <Result result={result} onDone={clearResult} />}
    </>
  );
};

export default PlaylistImport;
