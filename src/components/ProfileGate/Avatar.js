// Utils
import { LANG } from "@/i18n/lang";
import { avatarStyle, initialOf } from "@/utils/profile";

// Styles
import Styles from "./styles.module.scss";

// A profile's picture: the first letter of its name on its color. Sized by the className it's given.
const Avatar = ({ name, color, className = "" }) => {
  const initial = initialOf(name, LANG);
  return (
    <span className={`${Styles.avatar} ${className}`} style={avatarStyle(color)} aria-hidden="true">
      {initial ? <span data-profile-name>{initial}</span> : <Figure />}
    </span>
  );
};

// a head and shoulders, while there's no name to take a letter from
const Figure = () => (
  <svg className={Styles.figure} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="8.5" r="4.5" />
    <path d="M3.5 21a8.5 7 0 0 1 17 0z" />
  </svg>
);

export default Avatar;
