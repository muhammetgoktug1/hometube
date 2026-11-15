// Components
import VideoCard from "@/components/VideoCard";

// Styles
import Styles from "./styles.module.scss";

// The home and channel pages' grid of video cards. shown / total: a paged grid's counts (HOMETUBE_PAGING), as data-shown / data-total.
const VideoGrid = ({ videos, shown, total }) => (
  <section className={Styles.grid} data-shown={shown} data-total={total}>
    {videos.map((v) => (
      <VideoCard key={v.id} video={v} />
    ))}
  </section>
);

export default VideoGrid;
