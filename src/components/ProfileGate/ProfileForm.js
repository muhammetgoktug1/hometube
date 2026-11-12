"use client";

import { useId, useRef, useState } from "react";

// Components
import Icon from "@/components/Icon";
import Avatar from "./Avatar";

// Utils
import { COLORS, NAME_MAX, avatarStyle, isBack, profileName } from "@/utils/profile";

// Styles
import Styles from "./styles.module.scss";

// A profile's name and color, for a new profile or an existing one. Made for a TV remote as much as a
// mouse: up and down go between the name, the colors and the buttons, left and right pick a color,
// OK in the name sends it, Back cancels. onSubmit(name, color) answers with an error, or "" when done.
const ProfileForm = ({ title, intro, initial, submit = ["Create profile", "Creating…"], onSubmit, onCancel, compact }) => {
  const titleId = useId();
  const colorId = useId();
  const nameInput = useRef();
  const swatches = useRef([]);
  const buttons = useRef();
  const [name, setName] = useState(initial?.name || "");
  const [color, setColor] = useState(initial?.color ?? COLORS[0]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!profileName(name)) {
      setProblem("Give the profile a name.");
      nameInput.current.focus();
      return;
    }
    setBusy(true);
    setProblem("");
    const error = await onSubmit(profileName(name), color);
    setBusy(false);
    if (error) {
      setProblem(error);
      nameInput.current?.focus();
    }
  };

  const pickColor = (i) => {
    const next = (i + COLORS.length) % COLORS.length;
    setColor(COLORS[next]);
    swatches.current[next]?.focus();
  };

  const checked = () => swatches.current[Math.max(0, COLORS.indexOf(color))];
  const primary = () => buttons.current?.lastElementChild;

  // the rows a remote goes through with up and down
  const onKey = (e) => {
    if (isBack(e) && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    const swatch = swatches.current.indexOf(e.target);
    const inButtons = !!buttons.current?.contains(e.target);
    let to = null;
    if (e.key === "ArrowDown") to = e.target === nameInput.current ? checked() : swatch >= 0 ? primary() : null;
    else if (e.key === "ArrowUp") to = inButtons ? checked() : swatch >= 0 ? nameInput.current : null;
    else if (swatch >= 0 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      pickColor(swatch + (e.key === "ArrowLeft" ? -1 : 1));
      return;
    } else if (inButtons && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      to = e.key === "ArrowLeft" ? e.target.previousElementSibling : e.target.nextElementSibling;
    }
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    to.focus();
  };

  return (
    <form className={compact ? `${Styles.form} ${Styles.compact}` : Styles.form} onSubmit={send} onKeyDown={onKey} aria-labelledby={title ? titleId : undefined} noValidate>
      {title && (
        <h1 id={titleId} className={Styles.formTitle}>
          {title}
        </h1>
      )}
      {intro && <p className={Styles.intro}>{intro}</p>}

      <div className={Styles.formBody}>
        <Avatar name={name} color={color} className={Styles.preview} />
        <div className={Styles.fields}>
          <label className={Styles.field}>
            <span>Name</span>
            <input
              ref={nameInput}
              className={Styles.input}
              type="text"
              autoFocus
              autoComplete="off"
              enterKeyHint="done"
              maxLength={NAME_MAX}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className={Styles.field}>
            <span id={colorId}>Color</span>
            <div className={Styles.swatches} role="radiogroup" aria-labelledby={colorId}>
              {COLORS.map((c, i) => (
                <button
                  key={c}
                  ref={(el) => (swatches.current[i] = el)}
                  type="button"
                  role="radio"
                  className={Styles.swatch}
                  style={avatarStyle(c)}
                  aria-checked={c === color}
                  aria-label={`Color ${i + 1}`}
                  tabIndex={c === color ? 0 : -1}
                  onClick={() => pickColor(i)}
                >
                  {c === color && <Icon name="check" size={20} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {problem && (
        <p className={Styles.alert} role="alert">
          {problem}
        </p>
      )}

      <footer className={Styles.actions} ref={buttons}>
        {onCancel && (
          <button type="button" className={`btn ${Styles.action}`} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className={`btnBrand ${Styles.action}`} disabled={busy}>
          {busy ? submit[1] : submit[0]}
        </button>
      </footer>
    </form>
  );
};

export default ProfileForm;
