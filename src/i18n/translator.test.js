import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTranslator } from "./translator.js";

const dict = JSON.parse(readFileSync(new URL("./tr.json", import.meta.url), "utf8"));
const tr = createTranslator(dict);
const { text, units, months, decimal } = dict;

// sample values for each placeholder: [English, expected after translation]
const size = (n) => text["{n} GB"].replace("{n}", n.replace(".", decimal));
const SAMPLES = {
  n: ["3", "3"],
  h: ["2", "2"],
  m: ["14", "14"],
  size: ["1.4 GB", size("1.4")],
  free: ["2.5 GB", size("2.5")],
  total: ["9.1 GB", size("9.1")],
  used: ["1.4 GB", size("1.4")],
  length: ["2h 14m", text["{h}h {m}m"].replace("{h}", "2").replace("{m}", "14")],
  ago: ["3 days ago", text["{n} {unit} ago"].replace("{n}", "3").replace("{unit}", units.day)],
  date: ["12 Mar 2024", `12 ${months.Mar} 2024`],
  time: ["22:31", "22:31"],
  unit: ["days", units.day],
};
// names, titles and messages from YouTube are kept as they are
const sample = (name) => SAMPLES[name] || [`Sample ${name} One`, `Sample ${name} One`];
const fill = (s, i) => s.replace(/\{(\w+)\}/g, (_, name) => sample(name)[i]);

// every key gives its own translation, with the placeholders' values in place
let checked = 0;
for (const [key, value] of Object.entries(text)) {
  const english = fill(key, 0);
  const expected = value.replace(/\{(\w+)\}/g, (_, name) => sample(name)[1]);
  assert.equal(tr.run(english), expected, key);
  checked += 1;
}
assert.equal(checked, Object.keys(text).length);

// the white space around a text node stays
assert.equal(tr.run("  Cancel "), `  ${text.Cancel} `);
assert.equal(tr.run(" Add video / Shorts"), ` ${text["Add video / Shorts"]}`);

// unknown text, numbers and words kept in English give null: the page keeps what it has
assert.equal(tr.run("A sentence the dictionary has never seen"), null);
assert.equal(tr.run("4:05"), null);
assert.equal(tr.run("   "), null);
assert.equal(tr.run(""), null);
assert.equal(tr.run("Shorts"), null);
assert.equal(tr.run("Saved soon"), null);
assert.ok(tr.kept("Shorts") && tr.kept(" YouTube ") && !tr.kept("Cancel"));

// a name, a search or a message from YouTube inside a sentence is kept exactly
assert.equal(tr.run('Nothing in your library matches "Home".'), text['Nothing in your library matches "{query}".'].replace("{query}", "Home"));
assert.equal(tr.run("Delete Settings"), text["Delete {name}"].replace("{name}", "Settings"));
assert.equal(tr.run("From Home"), text["From {name}"].replace("{name}", "Home"));
const reason = "ERROR: [youtube] Sample: Video unavailable. This video is private";
assert.equal(tr.run(`Couldn't read that video: ${reason}`), text["Couldn't read that video: {reason}"].replace("{reason}", reason));
assert.equal(tr.run(`This video couldn't be downloaded: ${reason}`), text["This video couldn't be downloaded: {error}"].replace("{error}", reason));
// the server's own messages keep their English keys (an outside script matches on them)
assert.ok("This video is already in your library." in text);

// "A · B · C": only A may be a whole key; later parts carry names, such as a card's category
const savedAgo = text["Saved {ago}"].replace("{ago}", SAMPLES.ago[1]);
assert.equal(tr.run("Saved 3 days ago · 1.4 GB · Home"), `${savedAgo} · ${size("1.4")} · Home`);
assert.equal(tr.run("Saved just now · Settings"), `${text["Saved {ago}"].replace("{ago}", text["just now"])} · Settings`);
assert.equal(tr.run("12 saved videos · 3 Shorts"), `${text["{n} saved videos"].replace("{n}", "12")} · 3 Shorts`);
const published = text["Published {date}"].replace("{date}", `5 ${months.Sept} 2024`);
assert.equal(tr.run("Published 5 Sept 2024 · Saved 3 days ago · 0 MB"), `${published} · ${savedAgo} · ${text["0 MB"]}`);
assert.equal(tr.run("Publish date unknown · Saved 3 days ago · Settings"), `${text["Publish date unknown"]} · ${savedAgo} · Settings`);

// a text node whose placeholder sits in the next element: "HomeTube uses <b>1.4 GB</b>"
assert.equal(tr.prefix("HomeTube uses "), `${text["HomeTube uses {size}"].replace(/\s*\{size\}$/, "")} `);
assert.equal(tr.prefix("Nothing to see"), null);
// a whole key wins over a prefix: the "Saved" filter tab
assert.equal(tr.run("Saved "), `${text.Saved} `);

// formats from src/utils/shortcuts.js
assert.equal(tr.run("just now"), text["just now"]);
assert.equal(tr.run("1 hour ago"), text["{n} {unit} ago"].replace("{n}", "1").replace("{unit}", units.hour));
assert.equal(tr.run("45m"), text["{n}m"].replace("{n}", "45"));
assert.equal(tr.run("0 MB"), text["0 MB"]);
assert.equal(tr.run("320 MB"), text["{n} MB"].replace("{n}", "320"));
assert.equal(tr.run("2.5 MB/s"), text["{n} MB/s"].replace("{n}", `2${decimal}5`));
assert.equal(tr.run("5 Sept 2024"), `5 ${months.Sept} 2024`);
assert.equal(tr.run("1 Dec 2025"), `1 ${months.Dec} 2025`);
assert.equal(tr.run("Downloading 45%"), text["Downloading {n}%"].replace("{n}", "45"));
// a run React split over several nodes, joined
assert.equal(tr.run(["12", " ", "videos", " · ", "1.4 GB", " · ", "2h 14m"].join("")), fill(text["{n} videos · {size} · {length}"], 1).replace(SAMPLES.n[1], "12"));
assert.equal(
  tr.run(["The next cleanup deletes ", "1", " ", "video", " and frees", " ", "320 MB", "."].join("")),
  text["The next cleanup deletes {n} video and frees {size}."].replace("{n}", "1").replace("{size}", text["{n} MB"].replace("{n}", "320")),
);

// search: with Turkish, the dotted and the dotless i fold to "i"; without a language nothing changes
process.env.NEXT_PUBLIC_HOMETUBE_LANG = "tr";
const { matches } = await import("../utils/shortcuts.js");
const { fold } = await import("./lang.js");
assert.equal(fold("\u0130stanbul"), "istanbul");
assert.equal(fold("\u0131s\u0131k"), fold("ISIK"));
assert.ok(matches({ title: "\u0130stanbul by night" }, "", "istanbul"));
assert.ok(matches({ title: "Sample" }, "\u0130zmir channel", "izmir"));
assert.ok(!matches({ title: "Sample" }, "Other", "istanbul"));
process.env.NEXT_PUBLIC_HOMETUBE_LANG = "";
const english = await import("./lang.js?english");
assert.equal(english.fold("\u0130stanbul"), "\u0130stanbul".toLowerCase());
assert.equal(english.fold("\u0131"), "\u0131");

console.log(`translator ok (${checked} keys)`);
