import { useId, useState } from "react";
import Link from "next/link";

// Components
import Icon from "@/components/Icon";

// Store
import useDupeStore from "@/store/useDupeStore";
import useLibraryStore from "@/store/useLibraryStore";

// Utils
import { isWhole, rowsOf, summaryOf } from "@/utils/dupes";
import { fmtDuration } from "@/utils/shortcuts";

// Styles
import Styles from "./dupeNotice.module.scss";

// other videos shown before "Show N more": two rows of two on a TV
const LIMIT = 4;

const range = (from, to) => `${fmtDuration(from)}–${fmtDuration(to)}`;

// One other video, as a row like "Up next": its thumbnail, its title, and where the shared part sits in this video
// and in that one. Opens that video where the shared part starts. said: the heading already says all of this
// video is shared, so the row doesn't repeat it.
const Other = ({ row, here, there, said }) => {
  const { main, more } = row;
  const end = main.there + main.seconds;
  const whole = isWhole(main.here[0], main.here[1], here.duration);

  return (
    <li>
      <Link href={`/watch/${there.id}?t=${Math.floor(main.there)}`} className={Styles.other} data-dupe-row="" data-video={there.id}>
        <span className={Styles.thumb}>
          <img src={`/media/${there.id}/thumb.jpg`} alt="" loading="lazy" />
          {!!there.duration && <span className={Styles.duration}>{fmtDuration(there.duration)}</span>}
        </span>
        <div className={Styles.text}>
          <h3 title={there.title}>{there.title}</h3>
          {whole && !said && <p className={Styles.where}>All of this video</p>}
          {!whole && (
            <p className={Styles.where}>
              In this video <b>{range(main.here[0], main.here[1])}</b>
            </p>
          )}
          {isWhole(main.there, end, there.duration) ? (
            <p className={Styles.where}>All of that video</p>
          ) : (
            <p className={Styles.where}>
              In that video <b>{range(main.there, end)}</b>
            </p>
          )}
          {more > 0 && <p className={Styles.extra}>{more > 1 ? `+${more} more shared parts` : "+1 more shared part"}</p>}
        </div>
      </Link>
    </li>
  );
};

// "Also in your library": the other videos that hold this video's content, on every video that has some
// (the card badge only shows on new downloads). Information only; renders nothing while HOMETUBE_DUPES is off.
// A region named by its sentence; the rows are links and "Show N more" a button, so the remote reaches both.
const DupeNotice = ({ video }) => {
  const dupe = useDupeStore((state) => state.videos[video.id]);
  const videos = useLibraryStore((state) => state.videos);
  const [open, setOpen] = useState(false);
  const heading = useId();
  const byId = new Map(videos.map((v) => [v.id, v]));
  const rows = rowsOf(dupe, (id) => byId.get(id)?.status === "ready");
  if (!rows.length) return null;
  const shown = open ? rows : rows.slice(0, LIMIT);

  return (
    <section className={Styles.notice} aria-labelledby={heading} data-dupe-notice="" data-kind={dupe.kind}>
      <div className={Styles.head}>
        <span className={Styles.mark}>
          <Icon name="copies" size={22} />
        </span>
        <div>
          <p className={Styles.label}>Also in your library</p>
          <h2 id={heading}>{summaryOf(dupe, rows)}</h2>
        </div>
      </div>
      <ul className={Styles.list}>
        {shown.map((r) => (
          <Other key={r.id} row={r} here={video} there={byId.get(r.id)} said={dupe.kind === "same" || dupe.kind === "inside"} />
        ))}
      </ul>
      {rows.length > LIMIT && (
        <button type="button" className={`btn ${Styles.more}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show ${rows.length - LIMIT} more`}
        </button>
      )}
    </section>
  );
};

export default DupeNotice;
