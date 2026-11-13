"use client";

import { cloneElement, isValidElement } from "react";

// Hooks
import { useGrownUp } from "@/hooks/useKids";

// A control a kids profile doesn't get (adding, deleting, settings, links out to YouTube): rendered as it is
// with data-grownup="<name>" on its root while kids profiles are on, and not rendered at all while a kids
// profile's parent lock is shut, so nothing is left where it was. The child is an element, a Link, or one of
// our components that passes the extra props on to its root element.
const GrownUp = ({ name, children }) => {
  const props = useGrownUp(name);
  if (!props) return null;
  return isValidElement(children) ? cloneElement(children, props) : children;
};

export default GrownUp;
