import { useState } from "react";

// Components
import Icon from "@/components/Icon";
import Avatar from "@/components/ProfileGate/Avatar";
import ProfileForm from "@/components/ProfileGate/ProfileForm";

// Store
import useProfileStore from "@/store/useProfileStore";

// Utils
import { plural } from "@/utils/profile";
import { fmtBytes } from "@/utils/shortcuts";

// Styles
import Styles from "../styles.module.scss";
import Own from "./profiles.module.scss";

// the cleanup card's note while profiles are on
export const CLEANUP_NOTE = "Cleanup rules are off while profiles are on, so one person's rule can't delete another's videos.";

// whether the server said profiles are on
export const useProfilesOn = () => useProfileStore((s) => !!s.state);

// Settings › Storage: this profile's part of the library
export const ProfileShare = ({ mine }) => {
  const on = useProfilesOn();
  if (!on || !mine) return null;
  return (
    <p className={Own.share} data-profile-share>
      {plural(mine.count, "This profile: {size} in {n} video", "This profile: {size} in {n} videos").replace("{size}", fmtBytes(mine.used))}
    </p>
  );
};

// The first click arms it for three seconds, the second does it.
const useTwoClicks = () => {
  const [armed, setArmed] = useState("");
  const arm = (id) => {
    setArmed(id);
    setTimeout(() => setArmed((now) => (now === id ? "" : now)), 3000);
  };
  return [armed, arm, () => setArmed("")];
};

// The videos no profile has yet, moved to one profile in one go (see profile:claim).
const Orphans = ({ count, list, current }) => {
  const claim = useProfileStore((s) => s.claim);
  const [target, setTarget] = useState(current);
  const [keep, setKeep] = useState(true);
  const [armed, arm, disarm] = useTwoClicks();
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState("");
  const to = list.find((p) => p.id === target) || list.find((p) => p.id === current) || list[0];

  const move = async () => {
    if (armed !== true) return arm(true);
    disarm();
    setMoving(true);
    setProblem("");
    const res = await claim(to.id, count, keep);
    setMoving(false);
    if (res.error) return setProblem(res.error);
    setDone(plural(res.moved, "Moved {n} video to {name}.", "Moved {n} videos to {name}.").replace("{name}", () => to.name));
  };

  if (!count) {
    return done ? (
      <p className={Own.done} role="status">
        {done}
      </p>
    ) : null;
  }

  return (
    <div className={Own.orphans} data-profile-orphans>
      <b>{plural(count, "{n} video isn't in any profile yet.", "{n} videos aren't in any profile yet.")}</b>
      <label className={Styles.row}>
        <span>
          <b>Move them to</b>
        </span>
        <select value={to?.id} onChange={(e) => setTarget(e.target.value)}>
          {list.map((p) => (
            <option key={p.id} value={p.id} data-profile-name>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className={Own.check}>
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span>Keep their categories</span>
      </label>
      <div className={Own.moveRow}>
        {problem && (
          <span className={Own.alert} role="alert">
            {problem}
          </span>
        )}
        <button type="button" className={`btnBrand ${Own.move}`} data-armed={armed === true} disabled={moving} onClick={move}>
          {moving ? "Moving…" : armed === true ? "Click again to move" : plural(count, "Move {n} video", "Move {n} videos")}
        </button>
      </div>
    </div>
  );
};

// Settings › Profiles, only while profiles are on: rename, recolor or delete each profile, and move the
// videos no profile has to one of them.
const Profiles = () => {
  const { state, update, remove } = useProfileStore();
  const [editing, setEditing] = useState("");
  const [armed, arm, disarm] = useTwoClicks();
  const [problem, setProblem] = useState(["", ""]);

  if (!state) return null;
  const list = state.list || [];

  const save = async (id, name, color) => {
    const error = await update(id, { name, color });
    if (!error) setEditing("");
    return error;
  };

  const del = async (id) => {
    if (armed !== id) return arm(id);
    disarm();
    const error = await remove(id);
    setProblem([id, error]);
  };

  return (
    <section className={Styles.card} id="profiles" data-profiles-settings>
      <h2>Profiles</h2>
      <p>Everyone at home gets their own library: their own videos, categories and where they left off.</p>
      <ul className={Own.rows}>
        {list.map((p) => (
          <li key={p.id} data-profile-row={p.id}>
            <div className={Own.row}>
              <Avatar name={p.name} color={p.color} className={Own.face} />
              <span className={Own.who}>
                <b data-profile-name>{p.name}</b>
                <small>{plural(p.videos, "{n} saved video", "{n} saved videos")}</small>
              </span>
              <span className={Own.buttons}>
                <button type="button" className="btn" aria-expanded={editing === p.id} onClick={() => setEditing(editing === p.id ? "" : p.id)}>
                  Rename
                </button>
                <button type="button" className={`btn ${Own.delete}`} data-armed={armed === p.id} onClick={() => del(p.id)}>
                  <Icon name="trash" size={20} /> {armed === p.id ? "Click again to delete" : "Delete profile"}
                </button>
              </span>
            </div>
            {problem[0] === p.id && problem[1] && (
              <p className={Own.alert} role="alert">
                {problem[1]}
              </p>
            )}
            {editing === p.id && (
              <div className={Own.edit}>
                <ProfileForm
                  compact
                  initial={p}
                  submit={["Save", "Saving…"]}
                  onSubmit={(name, color) => save(p.id, name, color)}
                  onCancel={() => setEditing("")}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      <small>Videos only this profile has stay on the server and become unassigned.</small>
      <Orphans count={state.orphans} list={list} current={state.current?.id} />
    </section>
  );
};

export default Profiles;
