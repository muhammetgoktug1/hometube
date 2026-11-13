"use client";

// Components
import Icon from "@/components/Icon";

// Store
import useDupeStore from "@/store/useDupeStore";

// Utils
import { badgeFor, badgeText } from "@/utils/dupes";

// Styles
import Styles from "./styles.module.scss";

// A card's quiet note, under its details, that its content is somewhere else in the library too.
// Renders nothing until the duplicate check answers (never while HOMETUBE_DUPES is off).
const DupeBadge = ({ video }) => {
  const dupe = useDupeStore((state) => state.videos[video.id]);
  const all = useDupeStore((state) => state.only);
  if (video.status !== "ready" || !badgeFor(dupe, all)) return null;

  return (
    <span className={Styles.line} data-dupe-badge="" data-kind={dupe.kind}>
      <Icon name="copies" size={18} />
      {badgeText(dupe)}
    </span>
  );
};

export default DupeBadge;
