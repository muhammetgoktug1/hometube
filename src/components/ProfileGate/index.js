"use client";

import { useEffect, useRef, useState } from "react";

// Components
import Icon from "@/components/Icon";
import Logo from "@/components/Logo";
import Avatar from "./Avatar";
import ProfileForm from "./ProfileForm";

// Store
import useProfileStore, { bindProfiles } from "@/store/useProfileStore";

// Utils
import { columnsOf, gridMove, nextColor, plural, showGate } from "@/utils/profile";

// Styles
import Styles from "./styles.module.scss";

// "Who's watching?": one big tile per profile and one to add a profile, for a TV remote first. The
// arrow keys move between the tiles, OK picks one, and this device remembers the pick.
const Pick = ({ list, orphans, notice, focusAdd, onPick, onAdd }) => {
  const tiles = useRef();
  const [focus, setFocus] = useState(focusAdd ? list.length : 0);

  const onKey = (e) => {
    const buttons = [...tiles.current.querySelectorAll("button")];
    const i = buttons.indexOf(e.target);
    if (i < 0) return;
    const next = gridMove(i, e.key, buttons.length, columnsOf(buttons.map((b) => b.offsetTop)));
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setFocus(next);
    buttons[next].focus();
  };

  return (
    <main className={Styles.center}>
      {notice && (
        <p className={Styles.notice} role="status" data-profile-notice>
          That profile was removed. Pick another one.
        </p>
      )}
      <h1 className={Styles.title}>Who's watching?</h1>

      <div className={Styles.tiles} ref={tiles} onKeyDown={onKey}>
        {list.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={Styles.tile}
            tabIndex={i === focus ? 0 : -1}
            autoFocus={i === focus}
            onFocus={() => setFocus(i)}
            onClick={() => onPick(p)}
            data-profile-tile={p.id}
          >
            <Avatar name={p.name} color={p.color} className={Styles.face} />
            <span className={Styles.name} data-profile-name>
              {p.name}
            </span>
          </button>
        ))}
        <button
          type="button"
          className={Styles.tile}
          tabIndex={focus === list.length ? 0 : -1}
          autoFocus={focus === list.length}
          onFocus={() => setFocus(list.length)}
          onClick={onAdd}
          data-profile-add
        >
          <span className={`${Styles.face} ${Styles.addFace}`}>
            <Icon name="plus" />
          </span>
          <span className={Styles.name}>Add profile</span>
        </button>
      </div>

      {!!orphans && (
        <p className={Styles.hint} data-profile-hint>
          <span>{plural(orphans, "{n} video isn't in any profile yet.", "{n} videos aren't in any profile yet.")}</span>{" "}
          <span>Move them from Settings › Profiles.</span>
        </p>
      )}
    </main>
  );
};

// The whole page while profiles are on and this device hasn't picked one: "Create your profile" when
// there are none yet, else "Who's watching?".
const ProfileGate = () => {
  const { state, notice, pick, add } = useProfileStore();
  const list = state.list || [];
  const [adding, setAdding] = useState(false);
  const [back, setBack] = useState(false);
  const first = !list.length;

  if (first || adding) {
    return (
      <div className={Styles.gate} data-profile-gate="create">
        <header className={Styles.brand}>
          <Logo />
        </header>
        <main className={Styles.center}>
          <ProfileForm
            title={first ? "Create your profile" : "Add profile"}
            intro="Everyone at home gets their own library: their own videos, categories and where they left off."
            initial={{ color: nextColor(list) }}
            onSubmit={add}
            onCancel={
              first
                ? null
                : () => {
                    setAdding(false);
                    setBack(true);
                  }
            }
          />
        </main>
      </div>
    );
  }

  return (
    <div className={Styles.gate} data-profile-gate="pick">
      <header className={Styles.brand}>
        <Logo />
      </header>
      <Pick list={list} orphans={state.orphans} notice={notice} focusAdd={back} onPick={pick} onAdd={() => setAdding(true)} />
      <footer className={Styles.keys}>Arrow keys move · OK picks · this device remembers the pick</footer>
    </div>
  );
};

// For AppShell: the profile screen while it has to stand in for the page, else null (and always null
// when profiles are off: the server never says they're on).
export const useProfileGate = () => {
  useEffect(bindProfiles, []);
  const open = useProfileStore((s) => showGate(s.state));
  return open ? <ProfileGate /> : null;
};

export default ProfileGate;
