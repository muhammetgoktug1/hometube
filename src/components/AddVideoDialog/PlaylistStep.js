"use client";

import { useEffect, useId, useRef, useState } from "react";

// Components
import Icon from "@/components/Icon";

// Store
import usePlaylistStore from "@/store/usePlaylistStore";

// Utils
import { isPlaylistLink } from "@/utils/playlistLink";
import { getSocket } from "@/utils/socket";

// Styles
import Styles from "./playlistStep.module.scss";

// the server's answer for a link that turned out not to be a playlist: it is added as a video, as before
const NOT_A_PLAYLIST = "Paste a YouTube playlist link.";

// The add dialog's playlist part, only while the server offers playlists (usePlaylistStore.on); otherwise it
// takes nothing and shows nothing. A playlist link is read with playlist:browse and opens the picker; a link to a
// video inside a playlist asks every time whether to add just that video or the whole playlist; a link the
// server can't use leaves its reason in the dialog, which stays open for another link.
// step: null, { reading }, { ask: answer } or { error, video }.
export const usePlaylistStep = ({ url, category, addVideo, close }) => {
  const on = usePlaylistStore((state) => state.on);
  const [step, setStep] = useState(null);
  // the reading asked for last; an older answer arriving late (or after the link changed) is dropped
  const turn = useRef(0);

  const reset = () => {
    turn.current += 1;
    setStep(null);
  };

  const openList = (answer) => {
    reset();
    close();
    usePlaylistStore.getState().show(answer, category);
  };

  // true when the link is read as a playlist instead of added as a video
  const take = () => {
    if (!on || !isPlaylistLink(url)) return false;
    const mine = ++turn.current;
    setStep({ reading: true });
    getSocket().emit("playlist:browse", { url }, (res) => {
      if (turn.current !== mine) return;
      if (res.error === NOT_A_PLAYLIST) {
        setStep(null);
        return addVideo();
      }
      if (res.error) return setStep({ error: res.error, video: res.video || "" });
      if (res.video) return setStep({ ask: res });
      openList(res);
    });
    return true;
  };

  const view = step && <PlaylistStep step={step} onVideo={addVideo} onAll={() => openList(step.ask)} />;

  return { on, step, view, take, reset, asking: !!step?.ask, reading: !!step?.reading };
};

// What the add dialog shows in place of its hint while a playlist link is read, asked about or refused.
const PlaylistStep = ({ step, onVideo, onAll }) => {
  const questionId = useId();
  const first = useRef();

  // Enter (the remote's OK) takes the first choice: just this video, as the dialog always did
  useEffect(() => {
    if (step.ask) first.current?.focus();
  }, [step.ask]);

  if (step.reading) {
    return (
      <p className={Styles.reading} role="status" data-playlist-reading>
        <span className={Styles.spinner} aria-hidden="true" /> Reading the playlist on YouTube…
      </p>
    );
  }

  if (step.error) {
    return (
      <div className={Styles.notice} role="alert" data-playlist-notice data-kind="error">
        <span className={Styles.noticeIcon} aria-hidden="true">!</span>
        <p>{step.error}</p>
        {!!step.video && (
          <button type="button" className="btn" onClick={onVideo}>
            Add just this video
          </button>
        )}
      </div>
    );
  }

  const { playlist, video, videos, counts } = step.ask;
  const own = videos.find((v) => v.ytId === video);

  return (
    <div className={Styles.ask} role="group" aria-labelledby={questionId} data-playlist-ask>
      <p id={questionId} className={Styles.question}>
        This link is part of a playlist.
      </p>
      <div className={Styles.choices}>
        <button ref={first} type="button" className={Styles.choice} onClick={onVideo} data-playlist-ask-video>
          <span className={Styles.choiceIcon}>
            <Icon name="play" size={22} />
          </span>
          <span className={Styles.choiceText}>
            <b>Just this video</b>
            {own && <span className={Styles.importTitleVideo}>{own.title}</span>}
            {own?.saved && <em>In library</em>}
          </span>
        </button>
        <button type="button" className={Styles.choice} onClick={onAll} data-playlist-ask-all>
          <span className={Styles.choiceIcon}>
            <Icon name="playlist" size={22} />
          </span>
          <span className={Styles.choiceText}>
            <b>Whole playlist ({counts.listed})</b>
            <span className={Styles.importTitleList}>{playlist.title}</span>
            <span className={Styles.fresh}>
              {counts.fresh === 1 ? `${counts.fresh} video isn't in your library yet` : `${counts.fresh} videos aren't in your library yet`}
            </span>
          </span>
        </button>
      </div>
      <p className={Styles.askHint}>With the whole playlist you see its videos and pick which to download.</p>
    </div>
  );
};
