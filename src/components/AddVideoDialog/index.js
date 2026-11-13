"use client";

import { useId, useRef, useState } from "react";

// Components
import Icon from "@/components/Icon";

// Store
import useLibraryStore from "@/store/useLibraryStore";

// Utils
import { getSocket } from "@/utils/socket";

// Playlists (only while the server offers them)
import { usePlaylistStep } from "./PlaylistStep";

// Styles
import Styles from "@/styles/dialog.module.scss";

// A trigger button plus the dialog that saves a YouTube video or Short, or every Short of a channel, to the library;
// while the server offers playlists, a playlist link opens the picker for its videos (PlaylistStep).
// Other props (data-grownup) go on the trigger button.
const AddVideoDialog = ({ label = "Add video / Shorts", primary, ...trigger }) => {
  const dialog = useRef();
  const titleId = useId();
  const categories = useLibraryStore((state) => state.categories);
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const open = () => {
    setUrl("");
    setCategory("");
    setError("");
    playlist.reset();
    dialog.current.showModal();
  };

  const close = () => dialog.current.close();

  const addVideo = () => {
    playlist.reset();
    setBusy(true);
    setError("");
    getSocket().emit("video:add", { url, category }, (res) => {
      setBusy(false);
      if (res.error) return setError(res.error);
      close();
    });
  };

  const playlist = usePlaylistStep({ url, category, addVideo, close });

  const submit = (e) => {
    e.preventDefault();
    if (playlist.reading) return;
    // Enter while asked about a video inside a playlist: just this video, as before
    if (playlist.asking || !playlist.take()) addVideo();
  };

  return (
    <>
      <button type="button" className={primary ? "btnBrand" : "btn"} onClick={open} {...trigger}>
        <Icon name="plus" size={20} /> {label}
      </button>

      <dialog ref={dialog} className={Styles.dialog} aria-labelledby={titleId} onClick={(e) => e.target === dialog.current && close()}>
        <form className={Styles.sheet} onSubmit={submit}>
          <header className={Styles.head}>
            <h2 id={titleId}>{playlist.on ? "Add a video, Shorts or playlist" : "Add a video or Shorts"}</h2>
            <button type="button" className={Styles.close} onClick={close} aria-label="Close">
              <Icon name="close" size={20} />
            </button>
          </header>

          <label className={Styles.field}>
            <span>YouTube link</span>
            <input
              type="text"
              inputMode="url"
              required
              autoFocus
              placeholder={playlist.on ? "Video, Short, playlist or youtube.com/@channel/shorts link" : "Video, Short or youtube.com/@channel/shorts link"}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                playlist.reset();
              }}
            />
          </label>

          {!!categories.length && (
            <label className={Styles.field}>
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {playlist.view || (
            <p className={error ? Styles.error : Styles.hint}>
              {error ||
                (playlist.on
                  ? "A video shows up on the home page and a Short in Shorts once it's downloaded. A playlist link shows its videos so you can pick which to save; a channel's Shorts link (youtube.com/@name/shorts) saves all of its Shorts."
                  : "A video shows up on the home page and a Short in Shorts once it's downloaded. A channel's Shorts link (youtube.com/@name/shorts) saves all of its Shorts.")}
            </p>
          )}

          <footer className={Styles.foot}>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            {!playlist.asking && (
              <button className="btnBrand" disabled={busy || playlist.reading}>
                {busy || playlist.reading ? "Fetching…" : "Fetch"}
              </button>
            )}
          </footer>
        </form>
      </dialog>
    </>
  );
};

export default AddVideoDialog;
