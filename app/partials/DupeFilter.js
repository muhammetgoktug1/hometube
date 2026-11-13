// Store
import useDupeStore from "@/store/useDupeStore";
import useLibraryStore from "@/store/useLibraryStore";
import useUiStore from "@/store/useUiStore";

// Utils
import { warns } from "@/utils/dupes";

// Styles
import Styles from "./dupeFilter.module.scss";

// The last chip on the home page: only the videos whose content is also in another video, related ones side
// by side. Shows once the duplicate check answers and finds any; never while HOMETUBE_DUPES is off.
const DupeFilter = () => {
  const { only, setOnly, status, videos: dupes } = useDupeStore();
  const videos = useLibraryStore((state) => state.videos);
  const setCategory = useUiStore((state) => state.setCategory);
  const count = videos.filter((v) => !v.short && warns(dupes[v.id])).length;
  if (status !== "on" || !count) return null;

  const pick = () => {
    setCategory("");
    setOnly(!only);
  };

  // in its own wrapper: the chips after "All" are category names, which the language layer leaves as they are;
  // a toggle rather than a tab, so it says whether it's on with aria-pressed
  return (
    <span className={Styles.wrap}>
      <button type="button" aria-pressed={only} onClick={pick} data-dupe-filter="">
        Duplicates
        <small>{count}</small>
      </button>
    </span>
  );
};

export default DupeFilter;
