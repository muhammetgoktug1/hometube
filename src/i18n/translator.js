// Turns the interface's English text into another language, from a dictionary such as tr.json.
// Pure: a string in, a string out, or null when the dictionary has nothing for it (the caller keeps the English).
//
// Dictionary keys are the English text itself. They may hold placeholders:
//   {n} {h} {m}                      a number; its decimal point becomes dict.decimal
//   {size} {free} {total} {used}     a size such as "1.4 GB", translated in turn
//   {length}                         a running time such as "2h 14m"
//   {ago}                            "3 days ago", "just now"
//   {date}                           "12 Mar 2024" (month names from dict.months)
//   {time}                           "22:31", kept
//   {unit}                           year … minute, with or without an "s" (dict.units)
//   anything else ({name}, {query}, {reason}, {error})
//                                    a name, a title or a message from YouTube: kept exactly as it is

const SIZE = { re: "\\d+(?:\\.\\d+)? [GM]B", kind: "text" };
const PLACEHOLDERS = {
  n: { re: "\\d+(?:\\.\\d+)?", kind: "number" },
  h: { re: "\\d+", kind: "number" },
  m: { re: "\\d+", kind: "number" },
  size: SIZE,
  free: SIZE,
  total: SIZE,
  used: SIZE,
  length: { re: "\\d+m|\\d+h \\d+m", kind: "text" },
  ago: { re: "just now|\\d+ (?:year|month|week|day|hour|minute)s? ago", kind: "text" },
  date: { re: "\\d{1,2} [A-Z][a-z]{2,3} \\d{4}", kind: "text" },
  time: { re: "\\d{1,2}:\\d{2}", kind: "keep" },
  unit: { re: "(?:year|month|week|day|hour|minute)s?", kind: "unit" },
};
const ANYTHING = { re: "[\\s\\S]+?", kind: "keep" };

const DATE = /^(\d{1,2}) ([A-Z][a-z]{2,3}) (\d{4})$/;
const SEPARATOR = " · ";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// splits " text  " into its white space and the text between
const frame = (s) => /^(\s*)([\s\S]*?)(\s*)$/.exec(s).slice(1);

export const createTranslator = ({ text = {}, units = {}, months = {}, decimal = ".", keep = [] } = {}) => {
  const exact = new Map();
  const patterns = [];
  // "HomeTube uses {size}" → "HomeTube uses": for text whose placeholder sits in the next element
  const prefixes = new Map();

  for (const [key, value] of Object.entries(text)) {
    if (!/\{\w+\}/.test(key)) {
      exact.set(key, value);
      continue;
    }
    const names = [];
    const source = key
      .split(/(\{\w+\})/)
      .map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        if (!name) return escape(part);
        names.push(name);
        return `(${(PLACEHOLDERS[name] || ANYTHING).re})`;
      })
      .join("");
    // the most literal text first, so the most specific key wins
    patterns.push({ key, open: key.startsWith("{"), re: new RegExp(`^${source}$`), names, value, weight: key.replace(/\{\w+\}/g, "").length });

    const head = /^([^{}]*\S)\s+\{(\w+)\}$/.exec(key);
    const translated = head && new RegExp(`^([^{}]*\\S)\\s*\\{${head[2]}\\}$`).exec(value);
    if (translated) prefixes.set(head[1], translated[1]);
  }
  patterns.sort((a, b) => b.weight - a.weight);
  // the keys a phrase can match: by whether it has a " · " in it, then by its first character (keys starting
  // with that character or with a placeholder)
  const index = (list) => {
    const byFirst = new Map([["", list.filter((p) => p.open)]]);
    for (const { key } of list) {
      if (!key.startsWith("{") && !byFirst.has(key[0])) byFirst.set(key[0], list.filter((p) => p.open || p.key[0] === key[0]));
    }
    return byFirst;
  };
  const withDot = index(patterns.filter((p) => p.key.includes("·")));
  const withoutDot = index(patterns.filter((p) => !p.key.includes("·")));

  const number = (s) => (decimal === "." ? s : s.replace(".", decimal));
  const unit = (s) => units[s] ?? units[s.replace(/s$/, "")] ?? s;

  const cache = new Map();

  // one phrase, without its surrounding white space; withExact: false only allows keys with placeholders
  const phrase = (s, withExact = true) => {
    const id = `${withExact ? 1 : 0}${s}`;
    if (cache.has(id)) return cache.get(id);
    if (cache.size > 5000) cache.clear();
    let out = withExact && exact.has(s) ? exact.get(s) : null;

    const date = out == null && DATE.exec(s);
    if (date && months[date[2]]) out = `${date[1]} ${months[date[2]]} ${date[3]}`;

    const byFirst = s.includes("·") ? withDot : withoutDot;
    const candidates = byFirst.get(s[0]) || byFirst.get("");
    for (let i = 0; out == null && i < candidates.length; i++) {
      const { re, names, value } = candidates[i];
      const match = re.exec(s);
      if (!match) continue;
      const values = {};
      names.forEach((name, j) => {
        const raw = match[j + 1];
        const kind = (PLACEHOLDERS[name] || ANYTHING).kind;
        if (kind === "number") values[name] = number(raw);
        else if (kind === "unit") values[name] = unit(raw);
        else if (kind === "text") values[name] = phrase(raw) ?? raw;
        else values[name] = raw;
      });
      out = value.replace(/\{(\w+)\}/g, (all, name) => values[name] ?? all);
    }
    cache.set(id, out);
    return out;
  };

  const runs = new Map();

  // Text that may have been split over several text nodes, joined; null when nothing is known for it.
  // "A · B · C" that isn't a key as a whole: A is translated, B and C only through keys with placeholders and
  // the formats, because the later parts carry names (a card's "Saved 3 days ago · 1.4 GB · <category>").
  const run = (s) => {
    if (runs.has(s)) return runs.get(s);
    // a page left open for days sees many sizes and times: start over now and then
    if (runs.size > 5000) runs.clear();
    const [lead, core, trail] = frame(s);
    let out = /[A-Za-z]/.test(core) ? phrase(core) : null;
    if (out == null && core.includes(SEPARATOR)) {
      const [first, ...rest] = core.split(SEPARATOR);
      const head = phrase(first);
      const tail = rest.map((part) => phrase(part, false) ?? part);
      if (head != null || tail.some((part, i) => part !== rest[i])) out = [head ?? first, ...tail].join(SEPARATOR);
    }
    out = out == null ? null : lead + out + trail;
    runs.set(s, out);
    return out;
  };

  // Text followed by an element that holds the placeholder's value: "HomeTube uses <b>1.4 GB</b>".
  const prefix = (s) => {
    const [lead, core, trail] = frame(s);
    return prefixes.has(core) ? lead + prefixes.get(core) + trail : null;
  };

  const kept = new Set(keep);

  return { run, prefix, kept: (s) => kept.has(s.trim()) };
};
