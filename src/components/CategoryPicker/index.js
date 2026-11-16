"use client";

import { useEffect, useId, useRef, useState } from "react";

// Components
import Icon from "@/components/Icon";

// Store
import useLibraryStore from "@/store/useLibraryStore";

// Utils
import {
  addToCategory,
  assignedOf,
  countsOf,
  createAndAdd,
  deleteNote,
  enterAction,
  matchParts,
  pickerView,
  removeCategory,
  renameCategory,
  saveAction,
  videoCount,
} from "@/utils/categories";
import { getSocket } from "@/utils/socket";

// Styles
import Styles from "./styles.module.scss";

// at this width and below the picker is a sheet from the bottom of the screen
const PHONE_MAX = 640;
// what the sheet keeps free above it
const SHEET_GAP = 24;

const emit = (...args) => getSocket().emit(...args);

const Radio = ({ on }) => <span className={on ? `${Styles.radio} ${Styles.radioOn}` : Styles.radio}>{on && <Icon name="check" />}</span>;

// The watch page's category button and the window it opens (while the server offers category editing): pick the
// video's category with one press, make one by typing its name (a name there's a category for picks that one),
// and rename or delete a category right in its row. A window in the middle of the screen, larger on a TV; a sheet
// from the bottom on a phone. Other props (data-grownup) go on the button.
const CategoryPicker = ({ video, ...trigger }) => {
  const dialog = useRef();
  const search = useRef();
  const titleId = useId();
  const { videos, categories } = useLibraryStore();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  // how far the phone's keyboard pushes the sheet up
  const [lift, setLift] = useState(0);
  const [query, setQuery] = useState("");
  // the row being renamed: { id, draft }; the row asking before it's deleted: its id
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  // what the server refused, under the box (making, picking, deleting) or under a name being renamed
  const [fault, setFault] = useState("");
  const [renameFault, setRenameFault] = useState("");
  const [busy, setBusy] = useState(false);

  const assigned = assignedOf(video, categories);
  const counts = countsOf(videos);
  const view = pickerView(categories, query);
  const typed = !!query.trim();
  const empty = !categories.length;

  const reset = () => {
    setQuery("");
    setEditing(null);
    setConfirming(null);
    setFault("");
    setRenameFault("");
    setBusy(false);
  };

  const show = () => {
    reset();
    setSheet(window.innerWidth <= PHONE_MAX);
    setOpen(true);
    dialog.current.showModal();
    // nothing focused until something is pressed, so a TV's or a phone's keyboard doesn't come up by itself; with no
    // category yet the box is ready for a name
    if (categories.length) dialog.current.focus();
    else search.current.focus();
  };

  const close = () => {
    if (dialog.current?.open) dialog.current.close();
    // as well as on the dialog's close event, which a browser may hold back while the tab is in the background
    setOpen(false);
    reset();
  };

  // the sheet follows the phone's screen: turned around, or the keyboard coming up
  useEffect(() => {
    if (!open) return;
    const place = () => {
      setSheet(window.innerWidth <= PHONE_MAX);
      const vv = window.visualViewport;
      setLift(vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0);
    };
    place();
    const vv = window.visualViewport;
    window.addEventListener("resize", place);
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
    };
  }, [open]);

  // Press a row: the video goes in that category (or in none) and the window closes.
  const pick = (id) => {
    if (busy) return;
    if ((assigned?.id || "") === id) return close();
    setBusy(true);
    addToCategory(emit, video.id, id).then((res) => {
      setBusy(false);
      if (res.error) return setFault(res.error);
      close();
    });
  };

  // "Create “X” and add": makes the category (or finds the one by that name) and puts the video in it.
  const create = (name) => {
    if (busy || !name) return;
    setBusy(true);
    setFault("");
    createAndAdd(emit, video.id, name).then((res) => {
      setBusy(false);
      if (res.error) return setFault(res.error);
      close();
    });
  };

  // Enter in the box: picks the one by that name, or makes it
  const onSearchKey = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const act = enterAction(categories, query);
    if (act?.pick) pick(act.pick);
    else if (act?.create) create(act.create);
  };

  const startEdit = (c) => {
    setConfirming(null);
    setRenameFault("");
    setEditing({ id: c.id, draft: c.name });
  };

  const typeName = (draft) => {
    setRenameFault("");
    setEditing((e) => ({ ...e, draft }));
  };

  const save = () => {
    if (busy || !editing) return;
    const act = saveAction(categories, editing.id, editing.draft);
    if (act.error) return;
    if (act.same) return setEditing(null);
    setBusy(true);
    renameCategory(emit, editing.id, act.name).then((res) => {
      setBusy(false);
      if (res.error) return setRenameFault(res.error);
      setEditing(null);
    });
  };

  const askDelete = (id) => {
    setEditing(null);
    setFault("");
    setConfirming(id);
  };

  // the window stays open; the row goes once the server sends the library without it
  const remove = (id) => {
    if (busy) return;
    setBusy(true);
    removeCategory(emit, id).then((res) => {
      setBusy(false);
      setConfirming(null);
      if (res.error) setFault(res.error);
    });
  };

  const focusSearch = () => search.current.focus();

  const row = (c) => {
    const selected = assigned?.id === c.id;
    const count = counts.get(c.id) || 0;
    const marks = { "data-category-row": "", "data-category-id": c.id, "data-selected": selected, "data-count": count };

    if (editing?.id === c.id) {
      const problem = saveAction(categories, c.id, editing.draft).error || renameFault;
      return (
        <div key={c.id} className={Styles.edit} {...marks}>
          <label className={`${Styles.field} ${problem ? Styles.bad : ""}`}>
            <Icon name="pencil" />
            <input
              type="text"
              data-category-field
              value={editing.draft}
              onChange={(e) => typeName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save())}
              placeholder="Category name"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              autoFocus
            />
            {!!editing.draft && (
              <button type="button" className={Styles.clear} title="Clear" onClick={() => typeName("")}>
                <Icon name="close" />
              </button>
            )}
          </label>
          {!!problem && (
            <div className={Styles.fault} data-category-error>
              <Icon name="info" size={16} />
              {problem}
            </div>
          )}
          <div className={Styles.actions}>
            <button type="button" className={Styles.delete} data-category-delete onClick={() => askDelete(c.id)}>
              <Icon name="trash" />
              Delete
            </button>
            <span className={Styles.spacer} />
            <button type="button" className={Styles.secondary} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className={Styles.primary} data-category-save disabled={!!problem || busy} onClick={save}>
              Save
            </button>
          </div>
        </div>
      );
    }

    if (confirming === c.id) {
      return (
        <div key={c.id} className={Styles.confirm} {...marks} data-category-confirm>
          <strong>{`Delete “${c.name}”?`}</strong>
          <p>{deleteNote(count)}</p>
          <div className={Styles.confirmActions}>
            <button type="button" className={Styles.secondary} onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="button" className={Styles.danger} data-category-confirm-delete disabled={busy} onClick={() => remove(c.id)}>
              <Icon name="trash" />
              Delete category
            </button>
          </div>
        </div>
      );
    }

    const exact = view.exists?.id === c.id;
    const parts = matchParts(c.name, query);
    return (
      <div key={c.id} className={Styles.row} {...marks} data-exact={exact || undefined}>
        <button type="button" className={Styles.pick} onClick={() => pick(c.id)}>
          <Radio on={selected} />
          <span className={Styles.name} data-category-name>
            {parts ? (
              <>
                {parts[0]}
                <u>{parts[1]}</u>
                {parts[2]}
              </>
            ) : (
              c.name
            )}
          </span>
          {exact && <span className={Styles.tag}>Already exists</span>}
          <span className={Styles.count}>{videoCount(count)}</span>
        </button>
        <button type="button" className={Styles.editButton} data-category-edit onClick={() => startEdit(c)}>
          <Icon name="pencil" />
          Edit
        </button>
      </div>
    );
  };

  const foot = () => {
    if (view.exists) {
      return (
        <div className={Styles.note} data-category-exists>
          <strong data-category-name>{view.exists.name}</strong>
          {" already exists; no new one is made. Press it to add it to this video."}
        </div>
      );
    }
    if (view.create) {
      return (
        <button
          type="button"
          className={view.rows.length ? `${Styles.make} ${Styles.makeQuiet}` : Styles.make}
          data-category-create
          data-name={view.create}
          disabled={busy}
          onClick={() => create(view.create)}
        >
          <Icon name="plus" />
          {`Create “${view.create}” and add`}
        </button>
      );
    }
    if (empty) return null;
    return (
      <button type="button" className={`${Styles.make} ${Styles.makeQuiet}`} onClick={focusSearch}>
        <Icon name="plus" />
        New category
      </button>
    );
  };
  // while a row is renamed or asks before it's deleted, the window has no foot
  const footer = editing || confirming ? null : foot();

  return (
    <>
      <button
        type="button"
        className={`btn ${Styles.button}`}
        data-category-button
        data-category={assigned?.id || ""}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
        {...trigger}
      >
        <Icon name="tag" size={20} />
        {assigned ? (
          <span className={Styles.label} data-category-name>
            {assigned.name}
          </span>
        ) : (
          "No category"
        )}
        <Icon name="down" size={18} />
      </button>

      <dialog
        ref={dialog}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={Styles.dialog}
        data-category-picker
        data-variant="b"
        data-open={open}
        data-sheet={sheet}
        style={sheet ? { bottom: lift, maxHeight: `calc(100% - ${lift + SHEET_GAP}px)` } : undefined}
        onClick={(e) => e.target === dialog.current && close()}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClose={() => {
          setOpen(false);
          reset();
        }}
      >
        {sheet && <div className={Styles.grab} />}
        <div className={Styles.head}>
          <div className={Styles.heading}>
            <h2 id={titleId}>Category</h2>
            {/* the video's title: a <b> in the dialog is never translated */}
            <b>{video.title}</b>
          </div>
          <button type="button" className={Styles.close} title="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </div>

        <div className={Styles.body}>
          <label className={Styles.field}>
            <Icon name={empty ? "plus" : "search"} />
            <input
              ref={search}
              type="text"
              data-category-search
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFault("");
              }}
              onKeyDown={onSearchKey}
              placeholder={empty ? "New category name" : "Search or type a new category"}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
            />
            {typed && (
              <button
                type="button"
                className={Styles.clear}
                title="Clear"
                onClick={() => {
                  setQuery("");
                  focusSearch();
                }}
              >
                <Icon name="close" />
              </button>
            )}
          </label>
          {!!fault && (
            <div className={Styles.fault} data-category-error>
              <Icon name="info" size={16} />
              {fault}
            </div>
          )}
        </div>

        <div className={Styles.list}>
          {!typed && (
            <>
              <div className={Styles.row} data-category-none data-selected={!assigned}>
                <button type="button" className={Styles.pick} onClick={() => pick("")}>
                  <Radio on={!assigned} />
                  <span className={Styles.name}>No category</span>
                </button>
              </div>
              <div className={Styles.sep} />
            </>
          )}
          {view.rows.map(row)}
          {typed && !view.rows.length && (
            <div className={Styles.note}>
              {/* the name first, as the sentence reads in Turkish; its quotes are drawn by the style */}
              <strong className={Styles.quoted} data-category-name>
                {view.create}
              </strong>
              {" is not the name of any category."}
            </div>
          )}
          {empty && !typed && (
            <div className={Styles.empty} data-category-empty>
              <span className={Styles.emptyIcon}>
                <Icon name="tag" size={26} />
              </span>
              <strong>No categories yet</strong>
              <span>Type a name to make one and add this video to it.</span>
            </div>
          )}
        </div>

        {footer && <div className={Styles.foot}>{footer}</div>}
      </dialog>
    </>
  );
};

export default CategoryPicker;
