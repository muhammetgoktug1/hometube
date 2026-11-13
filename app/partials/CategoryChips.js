// Partials
import DupeFilter from "./DupeFilter";

// Store
import useDupeStore from "@/store/useDupeStore";
import useLibraryStore from "@/store/useLibraryStore";
import useUiStore from "@/store/useUiStore";

// Styles
import Styles from "../styles.module.scss";

const CategoryChips = () => {
  const categories = useLibraryStore((state) => state.categories);
  const { category, setCategory } = useUiStore();
  const { only, setOnly } = useDupeStore();
  const pick = (id) => {
    setCategory(id);
    setOnly(false);
  };

  return (
    <div className={Styles.chips} role="tablist" aria-label="Categories">
      <button type="button" role="tab" aria-selected={!category && !only} onClick={() => pick("")}>
        All
      </button>
      {categories.map((c) => (
        <button key={c.id} type="button" role="tab" aria-selected={category === c.id} onClick={() => pick(c.id)}>
          {c.name}
        </button>
      ))}
      <DupeFilter />
    </div>
  );
};

export default CategoryChips;
