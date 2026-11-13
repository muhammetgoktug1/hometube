"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

// Components
import Icon from "@/components/Icon";

// Hooks
import { useKids } from "@/hooks/useKids";

// Store
import useKidsStore from "@/store/useKidsStore";
import useProfileStore from "@/store/useProfileStore";

// Utils
import { LOCK, lockLeft, minutesLeft, question } from "@/utils/kids";
import { gridMove } from "@/utils/profile";

// Styles
import Styles from "./styles.module.scss";

// a release this soon is a click (a TV remote's OK may never hold): it opens the question instead
const TAP_MS = 600;
const RING = 2 * Math.PI * 15;

// The small grey tag next to a kids profile's name (profile menu, "Who's watching?").
export const KidsBadge = ({ className = "" }) => (
  <span className={`${Styles.badge} ${className}`} data-kids-badge>
    Kids
  </span>
);

// how long the parent lock stays open (ms), re-read every few seconds while it's shown
const useLockLeft = () => {
  const lock = useKidsStore((s) => s.lock);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  return lockLeft(lock, lock?.profile, Date.now());
};

// A ring that fills while the parent lock's row is held, around the lock.
const HoldRing = ({ progress, holding, open }) => (
  <span className={Styles.ring} data-holding={holding || undefined}>
    <svg className={Styles.ringTrack} viewBox="0 0 36 36" aria-hidden="true">
      <circle className={Styles.track} cx="18" cy="18" r="15" />
      <circle className={Styles.fill} cx="18" cy="18" r="15" strokeDasharray={RING} strokeDashoffset={RING * (1 - progress)} />
    </svg>
    <Icon name={open ? "unlock" : "lock"} size={18} />
  </span>
);

// The profile menu's last row on a kids profile, while the server offers the parent lock. Locked: "Parent
// lock"; holding it for LOCK.holdMs opens what the profile hides on this device for LOCK.minutes, a click asks
// the question instead (onAsk). Unlocked: locks again. className: the menu's own row class, so it sits in the
// list like the rows above it.
export const LockRow = ({ className, onAsk, onDone }) => {
  const mode = useKids();
  const offered = useProfileStore((s) => s.state?.parentLock === true);
  if (!offered) return null;
  if (mode === "unlocked") return <OpenRow className={className} onDone={onDone} />;
  if (mode === "locked") return <HoldRow className={className} onAsk={onAsk} onDone={onDone} />;
  return null;
};

// the ring shows the time left, running down
const OpenRow = ({ className, onDone }) => {
  const relock = useKidsStore((s) => s.relock);
  const left = useLockLeft();
  return (
    <button
      type="button"
      className={`${className} ${Styles.lockRow}`}
      onClick={() => {
        relock();
        onDone();
      }}
      data-kids-relock
    >
      <HoldRing progress={left / (LOCK.minutes * 60 * 1000)} open />
      <span className={Styles.lockText}>
        <span>Lock again</span>
        <small>{`Parent mode is on · ${minutesLeft(left)} min left`}</small>
      </span>
    </button>
  );
};

const HoldRow = ({ className, onAsk, onDone }) => {
  const current = useProfileStore((s) => s.state?.current);
  const unlock = useKidsStore((s) => s.unlock);
  const [progress, setProgress] = useState(0);
  // let go before the ring was full (and not a click), or the server didn't open it: say why, for a moment
  const [early, setEarly] = useState(false);
  const [problem, setProblem] = useState("");
  const hold = useRef({ start: 0, frame: 0, note: 0 });

  useEffect(
    () => () => {
      cancelAnimationFrame(hold.current.frame);
      clearTimeout(hold.current.note);
    },
    [],
  );

  const note = (set, value) => {
    set(value);
    clearTimeout(hold.current.note);
    hold.current.note = setTimeout(() => {
      setEarly(false);
      setProblem("");
    }, 2500);
  };

  const step = async () => {
    const p = Math.min(1, (performance.now() - hold.current.start) / LOCK.holdMs);
    setProgress(p);
    if (p < 1) {
      hold.current.frame = requestAnimationFrame(step);
      return;
    }
    hold.current.start = 0;
    // open only once the server has: it may say no
    const error = await unlock(current?.id);
    if (!error) return onDone();
    setProgress(0);
    note(setProblem, error);
  };

  const begin = () => {
    if (hold.current.start) return;
    hold.current.start = performance.now();
    hold.current.frame = requestAnimationFrame(step);
  };

  const end = (tap) => {
    if (!hold.current.start) return;
    cancelAnimationFrame(hold.current.frame);
    const short = performance.now() - hold.current.start < TAP_MS;
    hold.current.start = 0;
    setProgress(0);
    if (short) return tap && onAsk();
    note(setEarly, true);
  };

  // OK or Enter held on a remote or keyboard works like a press held on the row
  const isPress = (e) => e.key === "Enter" || e.key === " ";
  const onKeyDown = (e) => {
    if (!isPress(e) || e.repeat) return;
    e.preventDefault();
    begin();
  };

  const holding = progress > 0;
  return (
    <button
      type="button"
      className={`${className} ${Styles.lockRow}`}
      onPointerDown={(e) => e.button === 0 && begin()}
      onPointerUp={() => end(true)}
      onPointerLeave={() => end(false)}
      onPointerCancel={() => end(false)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => isPress(e) && end(true)}
      onContextMenu={(e) => e.preventDefault()}
      style={{ "--hold": progress }}
      data-kids-lock
      data-progress={Math.round(progress * 100)}
    >
      <HoldRing progress={progress} holding={holding} />
      <span className={Styles.lockText}>
        <span>Parent lock</span>
        <small>{holding ? "Keep holding…" : problem || (early ? "Hold until the ring is full" : "Hold for 3 seconds to open")}</small>
      </span>
    </button>
  );
};

// the keypad, as a phone's: ⌫ takes the last digit back
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

// The parent lock's second way in, for a remote that only clicks: a sum two digits long, typed on a keypad
// (or the remote's number keys). A wrong answer brings another sum, so clicking at random doesn't open it.
export const LockQuestion = ({ onDone, onCancel }) => {
  const current = useProfileStore((s) => s.state?.current);
  const unlock = useKidsStore((s) => s.unlock);
  const pad = useRef();
  const [sum, setSum] = useState(() => question());
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  // the server didn't open it: its message, and another sum
  const [problem, setProblem] = useState("");

  const another = () =>
    setTimeout(() => {
      setSum(question());
      setTyped("");
    }, 700);

  const press = async (key) => {
    if (typed.length === 2) return;
    if (key === "⌫") return setTyped(typed.slice(0, -1));
    const next = typed + key;
    setTyped(next);
    setWrong(false);
    setProblem("");
    if (next.length < 2) return;
    if (Number(next) === sum.sum) {
      const error = await unlock(current?.id);
      if (!error) return onDone();
      setProblem(error);
      return another();
    }
    setWrong(true);
    another();
  };

  // number keys type, arrows move through the keypad
  const onKey = (e) => {
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      return press(e.key);
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      return press("⌫");
    }
    const keys = [...pad.current.querySelectorAll("button")];
    const i = keys.indexOf(e.target);
    const next = i < 0 ? null : gridMove(i, e.key, keys.length, 3);
    if (next === null) return;
    e.preventDefault();
    keys[next].focus();
  };

  return (
    <div className={Styles.question} onKeyDown={onKey} data-kids-question>
      <h2 className={Styles.questionTitle}>Parent lock</h2>
      <p className={Styles.questionText}>Answer the sum to open adding and deleting on this device for 15 minutes.</p>
      <div className={Styles.sum} data-wrong={wrong || undefined}>
        <span>{`${sum.a} + ${sum.b} =`}</span>
        <span className={Styles.answer} aria-live="polite">
          <i>{typed[0] || ""}</i>
          <i>{typed[1] || ""}</i>
        </span>
      </div>
      <p className={Styles.questionNote} role="status">
        {problem || (wrong ? "Not quite. Here's another one." : "Or hold the Parent lock row for 3 seconds.")}
      </p>
      <div className={Styles.keypad} ref={pad}>
        {KEYS.map((key, i) =>
          key ? (
            <button
              key={key}
              type="button"
              className={Styles.key}
              onClick={() => press(key)}
              autoFocus={i === 0}
              aria-label={key === "⌫" ? "Delete a digit" : undefined}
              data-kids-key={key}
            >
              {key === "⌫" ? <Icon name="backspace" size={22} /> : key}
            </button>
          ) : (
            <span key="gap" />
          ),
        )}
      </div>
      <div className={Styles.questionActions}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
};

// The top bar's extra class names while kids profiles are on (see .topBar in the styles): its end keeps one width so the
// search box stays where it is whether the parent lock is open or shut; without kids profiles there are none.
export const useKidsBar = () => {
  const mode = useKids();
  if (!mode) return {};
  return { bar: Styles.topBar, end: Styles.topBarEnd, stats: mode === "unlocked" ? Styles.topBarStats : "" };
};

// In the top bar while the parent lock is open: how long it stays open, and a one-click way to lock again.
export const LockPill = () => {
  const mode = useKids();
  const relock = useKidsStore((s) => s.relock);
  if (mode !== "unlocked") return null;
  return <Pill onLock={relock} />;
};

const Pill = ({ onLock }) => {
  const left = minutesLeft(useLockLeft());
  return (
    <span className={Styles.pill} data-kids-unlocked>
      <span className={Styles.pillInfo} title="Adding and deleting are open on this device until it locks again">
        <Icon name="unlock" size={18} />
        <span className={Styles.pillLong}>{`Parent mode · ${left} min`}</span>
        <span className={Styles.pillShort}>{`${left} min`}</span>
      </span>
      <button type="button" className={Styles.pillLock} onClick={onLock} data-kids-relock>
        <Icon name="lock" size={16} />
        <span>Lock</span>
      </button>
    </span>
  );
};

// What /settings shows a kids profile while its parent lock is shut.
export const KidsBlocked = () => (
  <div className={Styles.blocked} data-kids-blocked>
    <span className={Styles.blockedIcon}>
      <Icon name="lock" size={34} />
    </span>
    <h2>Settings aren't available in a kids profile</h2>
    <p>A grown-up can open them for 15 minutes with the parent lock in the profile menu.</p>
    <Link href="/" className="btn">
      Back to home
    </Link>
  </div>
);
