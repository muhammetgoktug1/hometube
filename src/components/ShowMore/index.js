// Styles
import Styles from "./styles.module.scss";

// The "Show more" button under a paged grid (HOMETUBE_PAGING); where: home, channel or import, for data-more.
const ShowMore = ({ where, onClick }) => (
  <div className={Styles.more}>
    <button type="button" className="btn" data-more={where} onClick={onClick}>
      Show more
    </button>
  </div>
);

export default ShowMore;
