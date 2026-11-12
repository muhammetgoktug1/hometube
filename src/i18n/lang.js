// The interface language, set when the app is built (HOMETUBE_LANG → NEXT_PUBLIC_HOMETUBE_LANG); empty for English.
export const LANG = process.env.NEXT_PUBLIC_HOMETUBE_LANG || "";

// Lower case for searching. Turkish has a dotted and a dotless i, so both fold to a plain "i" there:
// "istanbul" finds "\u0130stanbul" and "\u0131" matches "i". Other languages search as before.
export const fold =
  LANG === "tr" ? (s) => s.toLowerCase().replace(/\u0307/g, "").replace(/\u0131/g, "i") : (s) => s.toLowerCase();
