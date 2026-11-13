"use client";

import { useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// Components
import GrownUp from "@/components/GrownUp";
import Icon from "@/components/Icon";
import { KidsBadge, LockQuestion, LockRow } from "@/components/Kids";
import Avatar from "@/components/ProfileGate/Avatar";
import ProfileForm from "@/components/ProfileGate/ProfileForm";

// Store
import useProfileStore from "@/store/useProfileStore";

// Utils
import { isBack, nextColor } from "@/utils/profile";

// Styles
import Styles from "./styles.module.scss";

// Who's watching, in the top bar: the avatar opens a list of the profiles to switch to without
// reloading the page, one to add a profile and the way to Settings › Profiles. Only while profiles are on.
// A kids profile gets the parent lock there instead of adding and managing (asking: its question).
const ProfileSwitch = () => {
  const router = useRouter();
  const pathname = usePathname();
  const dialog = useRef();
  const titleId = useId();
  const { state, pick, add } = useProfileStore();
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);

  if (!state?.current) return null;
  const { current, list } = state;

  const show = () => {
    setAdding(false);
    setAsking(false);
    setOpen(true);
    dialog.current.showModal();
  };

  const close = () => dialog.current?.close();
  const home = () => pathname !== "/" && router.push("/");

  const choose = (profile) => {
    close();
    if (profile.id === current.id) return;
    pick(profile);
    home();
  };

  const create = async (name, color) => {
    const error = await add(name, color);
    if (!error) {
      close();
      home();
    }
    return error;
  };

  const manage = () => {
    close();
    router.push("/settings");
  };

  // up and down through the list (a TV remote's arrows); Back steps out of the new profile form first
  const onKey = (e) => {
    e.stopPropagation();
    if (adding || asking) return;
    if (isBack(e) && e.key !== "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const items = [...dialog.current.querySelectorAll("button")];
    const i = items.indexOf(e.target);
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step || i < 0) return;
    e.preventDefault();
    items[Math.min(Math.max(i + step, 0), items.length - 1)].focus();
  };

  const onCancel = (e) => {
    if (!adding && !asking) return;
    e.preventDefault();
    setAdding(false);
    setAsking(false);
  };

  return (
    <>
      <button
        type="button"
        className={Styles.trigger}
        onClick={show}
        title={`Watching as ${current.name}`}
        aria-label={`Watching as ${current.name}`}
        aria-haspopup="dialog"
        data-profile-switch
      >
        <Avatar name={current.name} color={current.color} className={Styles.triggerFace} />
      </button>

      <dialog
        ref={dialog}
        className={Styles.menu}
        aria-labelledby={titleId}
        onKeyDown={onKey}
        onCancel={onCancel}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === dialog.current && close()}
      >
        {open && adding && (
          <div className={Styles.sheet}>
            <ProfileForm
              compact
              title="Add profile"
              initial={{ color: nextColor(list) }}
              onSubmit={create}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}
        {open && asking && (
          <div className={Styles.sheet}>
            <LockQuestion onDone={close} onCancel={() => setAsking(false)} />
          </div>
        )}
        {open && !adding && !asking && (
          <div className={Styles.list}>
            <h2 id={titleId} className={Styles.label}>
              Switch profile
            </h2>
            <ul>
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={Styles.item}
                    onClick={() => choose(p)}
                    autoFocus={p.id === current.id}
                    data-profile-item={p.id}
                    data-current={p.id === current.id || undefined}
                  >
                    <Avatar name={p.name} color={p.color} className={Styles.itemFace} />
                    <span className={Styles.itemName} data-profile-name>
                      {p.name}
                    </span>
                    {p.kid && <KidsBadge />}
                    {p.id === current.id && (
                      <span className={Styles.check}>
                        <Icon name="check" size={22} />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className={Styles.more}>
              <GrownUp name="profile-add">
                <button type="button" className={Styles.item} onClick={() => setAdding(true)}>
                  <span className={Styles.itemIcon}>
                    <Icon name="plus" size={22} />
                  </span>
                  <span className={Styles.itemName}>Add profile</span>
                </button>
              </GrownUp>
              <GrownUp name="profile-manage">
                <button type="button" className={Styles.item} onClick={manage}>
                  <span className={Styles.itemIcon}>
                    <Icon name="sliders" size={22} />
                  </span>
                  <span className={Styles.itemName}>Manage profiles</span>
                </button>
              </GrownUp>
              <LockRow className={Styles.item} onAsk={() => setAsking(true)} onDone={close} />
            </div>
          </div>
        )}
      </dialog>
    </>
  );
};

export default ProfileSwitch;
