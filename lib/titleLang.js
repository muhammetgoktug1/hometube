// Video titles in a list's own language. yt-dlp asks YouTube for a channel's uploads or a playlist in
// English, and YouTube answers with the English translation of a title wherever the uploader added
// one; the video read on its own comes with its own title. Off unless HOMETUBE_TITLE_LANG is set, and
// then a list is read exactly as before (same yt-dlp arguments, no other call):
//   auto: the list is read as before, its first video is read on its own for its language, and when
//         that isn't English the list is read again in that language; the language is remembered
//         for the list (in memory only), so the next reading asks in it straight away
//   a language code ("tr"): every list is asked for in that language, nothing is looked up
// Anything else counts as off, with one line at start. Reading in a language never makes a list fail:
// when it doesn't work the list comes as YouTube listed it.

// The languages YouTube answers in, as yt-dlp lists them (yt_dlp/extractor/youtube/_base.py,
// _SUPPORTED_LANG_CODES); youtube:lang refuses any other.
export const LANGS = [
  "af", "az", "id", "ms", "bs", "ca", "cs", "da", "de", "et", "en-IN", "en-GB", "en", "es",
  "es-419", "es-US", "eu", "fil", "fr", "fr-CA", "gl", "hr", "zu", "is", "it", "sw", "lv",
  "lt", "hu", "nl", "no", "uz", "pl", "pt-PT", "pt", "ro", "sq", "sk", "sl", "sr-Latn", "fi",
  "sv", "vi", "tr", "be", "bg", "ky", "kk", "mk", "mn", "ru", "sr", "uk", "el", "hy", "iw",
  "ur", "ar", "fa", "ne", "mr", "hi", "as", "bn", "pa", "gu", "or", "ta", "te", "kn", "ml",
  "si", "th", "lo", "my", "ka", "am", "km", "zh-CN", "zh-TW", "zh-HK", "ja", "ko",
];
const BY_LOWER = new Map(LANGS.map((code) => [code.toLowerCase(), code]));

// how long a list's language is used again, and for how many lists
export const REMEMBER_MS = 24 * 60 * 60_000;
export const REMEMBERED = 200;

// A video's language as yt-dlp gives it ("tr", "pt-BR", "en-US") as a code YouTube answers in:
// the code itself, else the code without its region, else "".
export function langCode(raw) {
  const text = String(raw ?? "").split("+")[0].trim().replace(/_/g, "-");
  if (!text) return "";
  return BY_LOWER.get(text.toLowerCase()) || BY_LOWER.get(text.split("-")[0].toLowerCase()) || "";
}

export const isEnglish = (raw) => /^en(?![a-z])/i.test(String(raw ?? "").trim());

// HOMETUBE_TITLE_LANG as { mode: "off" | "auto" | "fixed", lang }; a value that's neither auto nor
// a language code YouTube knows is off, with invalid set to it.
export function parseFlag(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { mode: "off", lang: "" };
  if (/^auto$/i.test(text)) return { mode: "auto", lang: "" };
  const lang = /^[a-z]{2,3}([-_][a-z0-9]{2,4})?$/i.test(text) ? langCode(text) : "";
  return lang ? { mode: "fixed", lang } : { mode: "off", lang: "", invalid: text };
}

// The line logged at start: none while it's off.
export function startLine(flag) {
  if (flag.invalid !== undefined) return `HOMETUBE_TITLE_LANG "${flag.invalid}" is neither auto nor a language YouTube knows: titles stay as listed`;
  if (flag.mode === "auto") return "titles in each list's own language";
  if (flag.mode === "fixed") return `titles in ${flag.lang}`;
  return "";
}

// yt-dlp's arguments for a list in lang; none for no language.
export const langArgs = (lang) => (lang ? ["--extractor-args", `youtube:lang=${lang}`] : []);

// Answers about the channel or YouTube itself, not the language: the list read as before gives
// them too, so it isn't asked for again.
const SAME_ANSWER = /does not have a \w+ tab|confirm you.re not a bot|rate-limited|try again later/i;

export const FLAG = parseFlag(process.env.HOMETUBE_TITLE_LANG);
const START = startLine(FLAG);
if (START) console.log(START);

// langOf(ytId): the video's language as yt-dlp reads it (lib/youtube.js probe). read(key, readList,
// first): readList(extra) reads the list with extra yt-dlp arguments; first(reading) is the YouTube id
// of its first saveable video, or "". key names the list (a channel's tabs share one).
export function createTitleLang({ flag = FLAG, langOf, now = Date.now, log = console }) {
  const known = new Map();

  function remembered(key) {
    const kept = known.get(key);
    if (kept && now() - kept.at < REMEMBER_MS) return kept;
    known.delete(key);
    return null;
  }

  function remember(key, lang) {
    known.delete(key);
    known.set(key, { lang, at: now() });
    while (known.size > REMEMBERED) known.delete(known.keys().next().value);
  }

  // the list in lang, or as YouTube listed it when that doesn't work
  const inLang = (readList, lang) => readList(langArgs(lang)).catch((err) => (SAME_ANSWER.test(err?.message) ? Promise.reject(err) : readList([])));

  async function read(key, readList, first) {
    if (flag.mode === "off") return readList([]);
    if (flag.mode === "fixed") return inLang(readList, flag.lang);
    const kept = remembered(key);
    if (kept) return kept.lang ? inLang(readList, kept.lang) : readList([]);
    const listed = await readList([]);
    const ytId = first(listed);
    if (!ytId) return listed;
    let language;
    try {
      language = await langOf(ytId);
    } catch {
      // tried again next time
      return listed;
    }
    const lang = isEnglish(language) ? "" : langCode(language);
    remember(key, lang);
    if (!lang) return listed;
    log.log(`titles in ${lang}: ${key}`);
    return readList(langArgs(lang)).catch(() => listed);
  }

  return { read, known, flag };
}
