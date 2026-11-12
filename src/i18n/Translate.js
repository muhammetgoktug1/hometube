"use client";

import { useEffect } from "react";

// Utils
import { LANG } from "./lang";

// The dictionary and the layer load only when the app is built with a language, and right away, while the page hydrates.
const LANGUAGES = {
  tr: () => Promise.all([import("./layer"), import("./translator"), import("./tr.json")]),
};
const loading = typeof window === "undefined" ? undefined : LANGUAGES[LANG]?.();

// The page stays hidden until it is translated, so it doesn't show in English first; without JavaScript it shows after 3 s.
const HIDE = "html:not([data-i18n]) body{visibility:hidden;animation:i18n-show 0s 3s forwards}@keyframes i18n-show{to{visibility:visible}}";

// Shows the interface in the language set at build time (HOMETUBE_LANG); renders and does nothing without one.
const Translate = () => {
  useEffect(() => {
    if (!loading) return;
    let stop;
    let gone = false;
    loading.then(
      ([layer, translator, dict]) => {
        if (!gone) stop = layer.start(translator.createTranslator(dict.default), LANG);
      },
      // no dictionary: show the page in English
      () => document.documentElement.setAttribute("data-i18n", "en"),
    );
    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  if (!LANGUAGES[LANG]) return null;
  return (
    <style href="hometube-i18n" precedence="default">
      {HIDE}
    </style>
  );
};

export default Translate;
