import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The flag is read when the module loads: off here (the reading with it on runs in child processes below).
delete process.env.HOMETUBE_TITLE_LANG;
const { LANGS, REMEMBER_MS, REMEMBERED, FLAG, langCode, isEnglish, parseFlag, startLine, langArgs, createTitleLang } = await import("./titleLang.js");

assert.deepEqual(FLAG, { mode: "off", lang: "" });

// ---- a video's language as a code YouTube answers in: the code, else without its region ----
assert.equal(langCode("tr"), "tr");
assert.equal(langCode("TR"), "tr");
assert.equal(langCode(" de "), "de");
assert.equal(langCode("pt-BR"), "pt");
assert.equal(langCode("pt_PT"), "pt-PT");
assert.equal(langCode("zh-cn"), "zh-CN");
assert.equal(langCode("sr-Latn"), "sr-Latn");
assert.equal(langCode("es-419"), "es-419");
assert.equal(langCode("es-MX"), "es");
assert.equal(langCode("en-US"), "en");
assert.equal(langCode("tr+en"), "tr");
assert.equal(langCode("zh-Hans"), "");
assert.equal(langCode("xx"), "");
assert.equal(langCode("xx-TR"), "");
assert.equal(langCode(""), "");
assert.equal(langCode(null), "");
assert.equal(langCode(undefined), "");
assert.ok(LANGS.includes("tr") && LANGS.includes("en") && LANGS.length > 80);

assert.ok(isEnglish("en"));
assert.ok(isEnglish("en-US"));
assert.ok(isEnglish("EN-gb"));
assert.ok(!isEnglish("tr"));
assert.ok(!isEnglish(""));
assert.ok(!isEnglish(undefined));

// ---- the flag ----
assert.deepEqual(parseFlag(undefined), { mode: "off", lang: "" });
assert.deepEqual(parseFlag(""), { mode: "off", lang: "" });
assert.deepEqual(parseFlag("  "), { mode: "off", lang: "" });
assert.deepEqual(parseFlag("auto"), { mode: "auto", lang: "" });
assert.deepEqual(parseFlag("AUTO"), { mode: "auto", lang: "" });
assert.deepEqual(parseFlag("tr"), { mode: "fixed", lang: "tr" });
assert.deepEqual(parseFlag("pt-BR"), { mode: "fixed", lang: "pt" });
assert.deepEqual(parseFlag("klingon"), { mode: "off", lang: "", invalid: "klingon" });
assert.deepEqual(parseFlag("xx"), { mode: "off", lang: "", invalid: "xx" });
assert.deepEqual(parseFlag("tr+en"), { mode: "off", lang: "", invalid: "tr+en" });
assert.deepEqual(parseFlag("1"), { mode: "off", lang: "", invalid: "1" });

assert.equal(startLine(parseFlag(undefined)), "");
assert.equal(startLine(parseFlag("auto")), "titles in each list's own language");
assert.equal(startLine(parseFlag("tr")), "titles in tr");
assert.match(startLine(parseFlag("klingon")), /^HOMETUBE_TITLE_LANG "klingon" is neither auto nor a language YouTube knows/);

assert.deepEqual(langArgs("tr"), ["--extractor-args", "youtube:lang=tr"]);
assert.deepEqual(langArgs(""), []);

// ---- the reading, with a stand-in list and language lookup ----
// readList(extra) answers with titles in the language asked for; langOf answers from `languages`.
function harness(flag, languages = {}, { failList = () => false } = {}) {
  const calls = [];
  const lines = [];
  let clock = 1_000_000;
  const readList = (key) => (extra) => {
    calls.push(["list", key, ...extra]);
    const lang = /^youtube:lang=(.+)$/.exec(extra[1] || "")?.[1] || "";
    const failure = failList(key, lang);
    if (failure) return Promise.reject(new Error(failure));
    return Promise.resolve({ lang, videos: [{ ytId: `${key}-1`, title: lang ? `own title (${lang})` : "translated title" }] });
  };
  const titles = createTitleLang({
    flag,
    now: () => clock,
    log: { log: (line) => lines.push(line) },
    langOf: async (ytId) => {
      calls.push(["lang", ytId]);
      const language = languages[ytId.split("-")[0]];
      if (language instanceof Error) throw language;
      return language;
    },
  });
  const first = (r) => r.videos[0]?.ytId;
  // a failed reading comes back as { error } so a wrong rejection fails an assertion, not the run
  const read = (key, pick = first) => titles.read(key, readList(key), pick).catch((err) => ({ error: err.message, videos: [{ title: `failed: ${err.message}` }] }));
  const take = () => calls.splice(0);
  return { read, take, lines, titles, tick: (ms) => (clock += ms) };
}

const OFF = parseFlag(undefined);
const AUTO = parseFlag("auto");

// off: one reading, no arguments added, no lookup
{
  const h = harness(OFF, { a: "tr" });
  assert.equal((await h.read("a")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "a"]]);
  assert.equal(h.titles.known.size, 0);
  assert.deepEqual(h.lines, []);
}

// auto, a Turkish list: read, look up the first video, read again in Turkish; then once, in Turkish
{
  const h = harness(AUTO, { a: "tr" });
  const r = await h.read("a");
  assert.equal(r.videos[0].title, "own title (tr)");
  assert.deepEqual(h.take(), [["list", "a"], ["lang", "a-1"], ["list", "a", "--extractor-args", "youtube:lang=tr"]]);
  assert.deepEqual(h.lines, ["titles in tr: a"]);
  assert.equal((await h.read("a")).videos[0].title, "own title (tr)");
  assert.deepEqual(h.take(), [["list", "a", "--extractor-args", "youtube:lang=tr"]]);
  // still remembered just before a day is up, looked up again after
  h.tick(REMEMBER_MS - 1);
  await h.read("a");
  assert.deepEqual(h.take(), [["list", "a", "--extractor-args", "youtube:lang=tr"]]);
  h.tick(1);
  assert.equal((await h.read("a")).videos[0].title, "own title (tr)");
  assert.deepEqual(h.take(), [["list", "a"], ["lang", "a-1"], ["list", "a", "--extractor-args", "youtube:lang=tr"]]);
}

// a region is dropped when YouTube doesn't answer in it
{
  const h = harness(AUTO, { b: "pt-BR" });
  assert.equal((await h.read("b")).videos[0].title, "own title (pt)");
  assert.deepEqual(h.take(), [["list", "b"], ["lang", "b-1"], ["list", "b", "--extractor-args", "youtube:lang=pt"]]);
}

// English, no language or one YouTube doesn't answer in: the list as listed, one reading (remembered: no lookup next time)
for (const language of ["en-US", "en", undefined, "", "xx"]) {
  const h = harness(AUTO, { c: language });
  assert.equal((await h.read("c")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "c"], ["lang", "c-1"]]);
  assert.equal((await h.read("c")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "c"]]);
  assert.deepEqual(h.lines, []);
}

// the lookup fails: the list as listed, looked up again next time
{
  const h = harness(AUTO, { d: new Error("Video unavailable") });
  assert.equal((await h.read("d")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "d"], ["lang", "d-1"]]);
  await h.read("d");
  assert.deepEqual(h.take(), [["list", "d"], ["lang", "d-1"]]);
  assert.equal(h.titles.known.size, 0);
}

// reading again in the language fails: the first reading; later the language reading, then as listed when it fails again
{
  const h = harness(AUTO, { e: "tr" }, { failList: (key, lang) => lang && "Unsupported language code: tr" });
  assert.equal((await h.read("e")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "e"], ["lang", "e-1"], ["list", "e", "--extractor-args", "youtube:lang=tr"]]);
  assert.equal((await h.read("e")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "e", "--extractor-args", "youtube:lang=tr"], ["list", "e"]]);
}

// an answer about the channel itself isn't asked for again; the list's own failure is the reading's
{
  const h = harness(AUTO, { f: "tr" }, { failList: (key, lang) => key === "f-shorts" && lang && "This channel does not have a shorts tab" });
  await h.read("f");
  h.take();
  // the channel's two tabs share the list's language (same key in lib/youtube.js); here the Shorts tab is its own key
  h.titles.known.set("f-shorts", { lang: "tr", at: 1_000_000 });
  assert.equal((await h.read("f-shorts")).error, "This channel does not have a shorts tab");
  assert.deepEqual(h.take(), [["list", "f-shorts", "--extractor-args", "youtube:lang=tr"]]);
  const g = harness(AUTO, { g: "tr" }, { failList: (key) => key === "g" && "The playlist does not exist." });
  assert.equal((await g.read("g")).error, "The playlist does not exist.");
  assert.deepEqual(g.take(), [["list", "g"]]);
}

// nothing saveable in the list: as listed, no lookup, nothing remembered
{
  const h = harness(AUTO, { h: "tr" });
  await h.read("h", () => "");
  assert.deepEqual(h.take(), [["list", "h"]]);
  assert.equal(h.titles.known.size, 0);
}

// at most REMEMBERED lists, the oldest forgotten first
{
  const h = harness(AUTO, {});
  for (let i = 0; i <= REMEMBERED; i++) await h.read(`k${i}`);
  assert.equal(h.titles.known.size, REMEMBERED);
  assert.ok(!h.titles.known.has("k0") && h.titles.known.has(`k${REMEMBERED}`));
}

// a fixed language: every list in it, no lookup; as listed when that fails
{
  const h = harness(parseFlag("tr"), { i: "de" }, { failList: (key, lang) => key === "j" && lang && "Unsupported language code: tr" });
  assert.equal((await h.read("i")).videos[0].title, "own title (tr)");
  assert.deepEqual(h.take(), [["list", "i", "--extractor-args", "youtube:lang=tr"]]);
  assert.equal((await h.read("j")).videos[0].title, "translated title");
  assert.deepEqual(h.take(), [["list", "j", "--extractor-args", "youtube:lang=tr"], ["list", "j"]]);
  assert.equal(h.titles.known.size, 0);
}

// ---- lib/youtube.js and lib/playlists.js with a stand-in yt-dlp on PATH, in a child process per flag value ----
// Synthetic ids: channels "UCsynthetic" + a two-letter language tag, videos <tag><v|s|p> + 8 digits.
const dir = mkdtempSync(path.join(tmpdir(), "hometube-titlelang-"));
const log = path.join(dir, "calls.log");
writeFileSync(
  path.join(dir, "yt-dlp"),
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const url = args.at(-1);
const lang = /^youtube:lang=(.+)$/.exec(args[args.indexOf("--extractor-args") + 1] || "")?.[1] || "";
const fail = (m) => { process.stderr.write("ERROR: [youtube] x: " + m + "\\n"); process.exit(1); };
const LANGUAGE = { tr: "tr", pt: "pt-BR", en: "en-US", nl: undefined, fx: "tr", nf: "tr" };
if (args.includes("--no-playlist")) {
  const id = /[?&]v=([\\w-]{11})/.exec(url)[1];
  if (id.startsWith("fa")) fail("Video unavailable");
  process.stdout.write(JSON.stringify({ id, title: "own title", language: LANGUAGE[id.slice(0, 2)] }));
  process.exit(0);
}
const channel = /\\/channel\\/UCsynthetic(\\w\\w)/.exec(url);
const tab = /\\/(videos|shorts)$/.exec(url)?.[1];
const tag = channel ? channel[1] : /list=PLsynthetic(\\w\\w)/.exec(url)[1];
if (tab === "shorts" && tag === "nf" && lang) fail("This channel does not have a shorts tab");
if (tag === "fx" && lang) fail("Unsupported language code: " + lang);
const kind = tab === "shorts" ? "s" : tab ? "v" : "p";
const entries = [1, 2, 3].map((n) => ({
  id: tag + kind + String(n).padStart(8, "0"),
  title: lang ? "own title " + n + " (" + lang + ")" : "translated title " + n,
  duration: 60,
  channel_id: "UCsynthetic" + tag + "0000000000000",
  channel: "Synthetic " + tag,
  url: "https://www.youtube.com/" + (kind === "s" ? "shorts/" : "watch?v=") + tag + kind + String(n).padStart(8, "0"),
}));
process.stdout.write(JSON.stringify({ id: "x", title: "Synthetic list", channel: "Synthetic " + tag, channel_id: "UCsynthetic" + tag, _type: "playlist", playlist_count: 3, entries }));
`,
);
chmodSync(path.join(dir, "yt-dlp"), 0o755);

const here = path.dirname(new URL(import.meta.url).pathname);
const chan = (tag) => `https://www.youtube.com/channel/UCsynthetic${tag}0000000000000`;
const STEPS = [
  ["tr videos", "channel", chan("tr"), "videos"],
  ["tr videos again", "channel", chan("tr"), "videos"],
  ["tr shorts", "channel", chan("tr"), "shorts"],
  ["pt shorts", "channel", chan("pt"), "shorts"],
  ["en videos", "channel", chan("en"), "videos"],
  ["en videos again", "channel", chan("en"), "videos"],
  ["no language", "channel", chan("nl"), "videos"],
  ["lookup fails", "channel", chan("fa"), "videos"],
  ["language refused", "channel", chan("fx"), "videos"],
  ["no shorts tab", "channel", chan("nf"), "videos"],
  ["no shorts tab, shorts", "channel", chan("nf"), "shorts"],
  ["tr playlist", "playlist", "PLsynthetictr00000000000000000001", ""],
  ["tr playlist again", "playlist", "PLsynthetictr00000000000000000001", ""],
];
function run(flag) {
  rmSync(log, { force: true });
  writeFileSync(log, "");
  const script = `
import { readFileSync } from "node:fs";
const { channelVideos } = await import(${JSON.stringify(pathToFileURL(path.join(here, "youtube.js")).href)});
const { readPlaylist } = await import(${JSON.stringify(pathToFileURL(path.join(here, "playlists.js")).href)});
const count = () => readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter(Boolean);
const out = {};
for (const [name, kind, target, tab] of ${JSON.stringify(STEPS)}) {
  const before = count().length;
  let result;
  try {
    result = kind === "channel" ? await channelVideos(target, tab) : await readPlaylist(target);
    result = result.videos.map((v) => v.title);
  } catch (err) {
    result = { error: err.message };
  }
  out[name] = { result, calls: count().slice(before).map((l) => JSON.parse(l)) };
}
console.log(JSON.stringify(out));
`;
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  if (flag === undefined) delete env.HOMETUBE_TITLE_LANG;
  else env.HOMETUBE_TITLE_LANG = flag;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, cwd: dir, encoding: "utf8" });
  const lines = stdout.trim().split("\n");
  return { out: JSON.parse(lines.pop()), lines };
}

const JS = ["--js-runtimes", `node:${process.execPath}`];
const listArgs = (url, extra = [], limit = 300) => [...JS, "-J", "--flat-playlist", "-I", `1:${limit}`, "--no-warnings", ...extra, url];
const plArgs = (list, extra = []) => listArgs(`https://www.youtube.com/playlist?list=${list}`, extra, 1001);
const probeArgs = (id) => [...JS, "-J", "--no-playlist", "--no-warnings", `https://www.youtube.com/watch?v=${id}`];
const TR = ["--extractor-args", "youtube:lang=tr"];
const translated = ["translated title 1", "translated title 2", "translated title 3"];
const own = (lang) => [1, 2, 3].map((n) => `own title ${n} (${lang})`);

// off, and an invalid value: every list read exactly as before (the same arguments, one call each), nothing looked up
for (const flag of [undefined, "", "klingon"]) {
  const { out, lines } = run(flag);
  for (const [name, kind, target, tab] of STEPS) {
    const expected = kind === "channel" ? listArgs(`${target}/${tab}`) : plArgs(target);
    assert.deepEqual(out[name].calls, [expected], `${flag}: ${name}`);
    assert.deepEqual(out[name].result, translated, `${flag}: ${name}`);
  }
  assert.deepEqual(lines, flag === "klingon" ? [startLine(parseFlag("klingon"))] : []);
}

// auto: a first reading in three calls (list, its first video, list in the language), then one
{
  const { out, lines } = run("auto");
  const c = (name) => out[name];
  assert.deepEqual(lines[0], "titles in each list's own language");
  assert.deepEqual(c("tr videos").calls, [listArgs(`${chan("tr")}/videos`), probeArgs("trv00000001"), listArgs(`${chan("tr")}/videos`, TR)]);
  assert.deepEqual(c("tr videos").result, own("tr"));
  assert.deepEqual(c("tr videos again").calls, [listArgs(`${chan("tr")}/videos`, TR)]);
  assert.deepEqual(c("tr videos again").result, own("tr"));
  // the channel's Shorts tab knows the channel's language already
  assert.deepEqual(c("tr shorts").calls, [listArgs(`${chan("tr")}/shorts`, TR)]);
  assert.deepEqual(c("tr shorts").result, own("tr"));
  // a channel first opened on its Shorts tab
  const PT = ["--extractor-args", "youtube:lang=pt"];
  assert.deepEqual(c("pt shorts").calls, [listArgs(`${chan("pt")}/shorts`), probeArgs("pts00000001"), listArgs(`${chan("pt")}/shorts`, PT)]);
  assert.deepEqual(c("pt shorts").result, own("pt"));
  // English: no second list, and no lookup the next time
  assert.deepEqual(c("en videos").calls, [listArgs(`${chan("en")}/videos`), probeArgs("env00000001")]);
  assert.deepEqual(c("en videos").result, translated);
  assert.deepEqual(c("en videos again").calls, [listArgs(`${chan("en")}/videos`)]);
  assert.deepEqual(c("no language").calls, [listArgs(`${chan("nl")}/videos`), probeArgs("nlv00000001")]);
  assert.deepEqual(c("no language").result, translated);
  assert.deepEqual(c("lookup fails").calls, [listArgs(`${chan("fa")}/videos`), probeArgs("fav00000001")]);
  assert.deepEqual(c("lookup fails").result, translated);
  assert.deepEqual(c("language refused").calls, [listArgs(`${chan("fx")}/videos`), probeArgs("fxv00000001"), listArgs(`${chan("fx")}/videos`, TR)]);
  assert.deepEqual(c("language refused").result, translated);
  assert.deepEqual(c("no shorts tab").result, own("tr"));
  // a channel without Shorts says so in any language: one call, the same answer as before
  assert.deepEqual(c("no shorts tab, shorts").calls, [listArgs(`${chan("nf")}/shorts`, TR)]);
  assert.deepEqual(c("no shorts tab, shorts").result, { error: "This channel does not have a shorts tab" });
  const PL = "PLsynthetictr00000000000000000001";
  assert.deepEqual(c("tr playlist").calls, [plArgs(PL), probeArgs("trp00000001"), plArgs(PL, TR)]);
  assert.deepEqual(c("tr playlist").result, own("tr"));
  assert.deepEqual(c("tr playlist again").calls, [plArgs(PL, TR)]);
  assert.deepEqual(c("tr playlist again").result, own("tr"));
  assert.ok(lines.includes(`titles in tr: channel ${chan("tr")}`) && lines.includes(`titles in tr: playlist ${PL}`));
}

// a fixed language: every list in it, one call, nothing looked up
{
  const { out, lines } = run("tr");
  assert.deepEqual(lines, ["titles in tr"]);
  assert.deepEqual(out["tr videos"].calls, [listArgs(`${chan("tr")}/videos`, TR)]);
  assert.deepEqual(out["en videos"].calls, [listArgs(`${chan("en")}/videos`, TR)]);
  assert.deepEqual(out["en videos"].result, own("tr"));
  assert.deepEqual(out["language refused"].calls, [listArgs(`${chan("fx")}/videos`, TR), listArgs(`${chan("fx")}/videos`)]);
  assert.deepEqual(out["language refused"].result, translated);
  assert.ok(Object.values(out).every((s) => s.calls.every((a) => !a.includes("--no-playlist"))));
}
rmSync(dir, { recursive: true, force: true });

console.log("title language ok");
