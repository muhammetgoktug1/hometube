import { useEffect, useState } from "react";

// Store
import useProfileStore from "@/store/useProfileStore";

// Styles
import Own from "./profiles.module.scss";

// Settings › Profiles: a profile's "Kids profile" switch, one of the row's pills, only while kids profiles are on
// (the server marks every profile one way or the other). The server keeps at least one grown-up profile and turns the switch down
// otherwise; onAnswer gets its message, or "" once it's done.
const KidsToggle = ({ profile, onAnswer }) => {
  const update = useProfileStore((s) => s.update);
  // the value just picked, until the server's profiles say the same
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    if (picked === profile.kid) setPicked(null);
  }, [profile.kid, picked]);

  if (typeof profile.kid !== "boolean") return null;
  const on = picked ?? profile.kid;

  const flip = async (e) => {
    const kid = e.target.checked;
    setPicked(kid);
    onAnswer("");
    const error = await update(profile.id, { kid });
    if (error) setPicked(null);
    onAnswer(error);
  };

  return (
    <label className={Own.kids}>
      <input type="checkbox" role="switch" checked={on} aria-checked={on} onChange={flip} data-kids-toggle data-profile={profile.id} />
      <span>Kids profile</span>
    </label>
  );
};

export default KidsToggle;
