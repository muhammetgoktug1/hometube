import path from "node:path";
import { Worker } from "node:worker_threads";
import mongoose from "mongoose";
import { Video } from "./models.js";
import { mediaDir } from "./media.js";
import { progress } from "./queue.js";
import { ALGORITHM, fingerprint } from "./chromaprint.js";
import { RATE, classify, liveBlocks } from "./dupeMatch.js";

// Finds videos whose content is also somewhere else in the library: the same video saved twice, an
// episode inside a compilation, or stretches two videos share. Off unless HOMETUBE_DUPES=1. It only
// reads the library: it writes its own two collections and never changes or deletes a video.
const ON = /^(1|true|yes)$/i.test(process.env.HOMETUBE_DUPES || "");

// a short break between two videos, a longer one with nothing to do or while something else needs the disk
const REST_MS = 500;
const IDLE_MS = 60_000;
const BUSY_MS = 15_000;
// the player reports where it is every 10 seconds; no word for this long means nothing is playing
const PLAYING_MS = 120_000;

const { ObjectId } = mongoose.Schema.Types;

const fingerprintSchema = new mongoose.Schema(
  {
    video: { type: ObjectId, ref: "Video", required: true, unique: true },
    algo: String,
    // fpcalc's raw values, uint32 little-endian, about 8 a second
    fp: Buffer,
    items: Number,
    // where the blocks with sound start (in values); silence can't be compared
    live: [Number],
    duration: Number,
    // "download": added after the check was turned on; "backfill": already in the library then
    source: { type: String, enum: ["download", "backfill"] },
    // fpcalc couldn't read the file; tried again after a restart
    error: String,
    // when it was compared with the videos saved before it; unset until then
    matchedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// A stretch two videos share at one offset: a is the newer video, b the older one.
const dupeSchema = new mongoose.Schema(
  {
    a: { type: ObjectId, ref: "Video", required: true, index: true },
    b: { type: ObjectId, ref: "Video", required: true, index: true },
    // seconds: a's time + offset is b's time; shift is the same in fingerprint values
    offset: Number,
    shift: Number,
    ber: Number,
    votes: Number,
    // seconds in a (a0–a1) and in b (b0–b1); blocks: where each matching block starts in a, in values
    pieces: [{ _id: false, a0: Number, a1: Number, b0: Number, b1: Number, ber: Number, blocks: [Number] }],
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// created only when the check is on, so the collections don't exist otherwise
let Fingerprint;
let Dupe;
// videos added after this get "download" fingerprints
let since;
let lastPlayed = 0;
let paused;
let batch = { count: 0, startedAt: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secs = (values) => Math.round((values / RATE) * 1000) / 1000;

// Fingerprints come back as Buffers; copied so the values line up.
const valuesOf = (buffer) => new Uint32Array(new Uint8Array(buffer).buffer);

export function startDupes(io) {
  if (!ON) return;
  Fingerprint = mongoose.model("Fingerprint", fingerprintSchema, "fingerprints");
  Dupe = mongoose.model("Dupe", dupeSchema, "dupes");

  io.on("connection", (socket) => {
    socket.on("video:position", (data) => {
      if (mongoose.isValidObjectId(data?.id) && Number.isFinite(Number(data?.position))) lastPlayed = Date.now();
    });
    // read-only: dupes(ack) for the whole library, dupes(id, ack) for one video
    socket.on("dupes", async (...args) => {
      const ack = args.pop();
      if (typeof ack !== "function") return;
      ack(await dupesOf(args[0]).catch((err) => ({ error: err.message })));
    });
  });

  run().catch((err) => console.error("duplicate check stopped", err.message));
}

async function run() {
  const first = await Fingerprint.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).lean();
  since = first?.createdAt ?? new Date();
  // a file fpcalc couldn't read gets another try
  await Fingerprint.deleteMany({ error: { $exists: true } });
  const [done, total] = await Promise.all([Fingerprint.countDocuments(), Video.countDocuments({ status: "ready" })]);
  console.log(`duplicate check on: ${done} of ${total} videos fingerprinted`);
  for (;;) {
    const wait = await step().catch((err) => {
      console.error("duplicate check failed", err.message);
      return IDLE_MS;
    });
    await sleep(wait);
  }
}

// Playback and downloads come first: what the check waits for, if anything.
async function busyWith() {
  if (Date.now() - lastPlayed < PLAYING_MS) return "a video is playing";
  if (progress.size || (await Video.exists({ status: "downloading" }))) return "a download is running";
}

// One thing at a time: fingerprint the oldest video without one; once all have one, compare the
// new ones with the videos saved before them. Returns how long to wait before the next step.
async function step() {
  const busy = await busyWith();
  if (busy) {
    if (paused !== busy) console.log(`duplicate check waits: ${busy}`);
    paused = busy;
    return BUSY_MS;
  }
  if (paused) console.log("duplicate check goes on");
  paused = undefined;

  const ready = await Video.find({ status: "ready" }, { _id: 1, createdAt: 1 }).sort({ createdAt: 1, _id: 1 }).lean();
  const prints = await Fingerprint.find({}, { video: 1, error: 1, matchedAt: 1 }).lean();
  const known = new Map(prints.map((p) => [String(p.video), p]));
  const at = ready.findIndex((v) => !known.has(String(v._id)));
  if (at >= 0) {
    await printOne(ready, at);
    return REST_MS;
  }
  if (batch.count) {
    console.log(`fingerprinted ${batch.count} videos in ${Math.round((Date.now() - batch.startedAt) / 1000)} s`);
    batch = { count: 0, startedAt: 0 };
  }
  if (ready.some((v) => !known.get(String(v._id)).error && !known.get(String(v._id)).matchedAt)) {
    await compareNew(ready);
    return REST_MS;
  }
  await forgetRemoved(prints);
  return IDLE_MS;
}

async function printOne(ready, at) {
  const video = ready[at];
  if (!batch.count) batch.startedAt = Date.now();
  const doc = { video: video._id, algo: ALGORITHM, source: video.createdAt > since ? "download" : "backfill" };
  try {
    const { fp, duration } = await fingerprint(path.join(mediaDir(video._id), "video.mp4"));
    Object.assign(doc, { fp: Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength), items: fp.length, live: liveBlocks(fp), duration });
  } catch (err) {
    doc.error = err.message.slice(0, 300);
    console.error("fingerprint failed", String(video._id), doc.error);
  }
  // removed while it was being read
  if (!(await Video.exists({ _id: video._id }))) return;
  await Fingerprint.create(doc);
  // videos saved after this one were compared without it: compare them again
  const later = ready.slice(at + 1).map((v) => v._id);
  if (later.length) await Fingerprint.updateMany({ video: { $in: later }, matchedAt: { $exists: true } }, { $unset: { matchedAt: 1 } });
  batch.count += 1;
  if (batch.count % 25 === 0) console.log(`fingerprinted ${batch.count} videos, ${ready.length - at - 1} to go`);
}

// The comparing itself runs in a worker thread, so the server keeps answering meanwhile.
function compareInWorker(fps, queries) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dupeMatch.js", import.meta.url), { workerData: "dupeMatch" });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`comparing stopped (exit ${code})`)));
    worker.postMessage({ fps, queries }, fps.map((fp) => fp.buffer));
  });
}

const dupeDoc = (a, b, { shift, ber, votes, pieces }) => ({
  a,
  b,
  shift,
  offset: secs(shift),
  ber,
  votes,
  pieces: pieces.map((p) => ({ a0: secs(p.a0), a1: secs(p.a1), b0: secs(p.b0), b1: secs(p.b1), ber: p.ber, blocks: p.blocks })),
});

async function compareNew(ready) {
  const startedAt = Date.now();
  const order = new Map(ready.map((v, i) => [String(v._id), i]));
  const prints = (await Fingerprint.find({ error: { $exists: false }, video: { $in: ready.map((v) => v._id) } }, { video: 1, fp: 1, matchedAt: 1 }))
    .sort((x, y) => order.get(String(x.video)) - order.get(String(y.video)));
  const queries = prints.flatMap((p, i) => (p.matchedAt ? [] : [i]));
  const results = await compareInWorker(prints.map((p) => valuesOf(p.fp)), queries);
  let shared = 0;
  for (const { query, rels } of results) {
    const a = prints[query].video;
    await Dupe.deleteMany({ a });
    if (rels.length) await Dupe.insertMany(rels.map((r) => dupeDoc(a, prints[r.ref].video, r)));
    await Fingerprint.updateOne({ video: a }, { matchedAt: new Date() });
    shared += rels.length;
  }
  console.log(`compared ${queries.length} videos with the library: ${shared} shared stretches in ${Date.now() - startedAt} ms`);
}

// Drops what's left of videos that were removed.
async function forgetRemoved(prints) {
  const ids = prints.map((p) => p.video);
  const kept = new Set((await Video.find({ _id: { $in: ids } }, { _id: 1 }).lean()).map((v) => String(v._id)));
  const gone = ids.filter((id) => !kept.has(String(id)));
  if (!gone.length) return;
  await Dupe.deleteMany({ $or: [{ a: { $in: gone } }, { b: { $in: gone } }] });
  await Fingerprint.deleteMany({ video: { $in: gone } });
}

// What each video shares with the rest of the library (see classify in lib/dupeMatch.js):
// { id, kind, coverage, source, others, partners }, kind "pending" until it has been compared.
async function dupesOf(id) {
  if (id !== undefined && !mongoose.isValidObjectId(id)) return { error: "This video no longer exists." };
  const [ready, prints, rels] = await Promise.all([
    Video.find({ status: "ready" }, { _id: 1 }).lean(),
    Fingerprint.find({}, { video: 1, items: 1, live: 1, source: 1, error: 1, matchedAt: 1 }).lean(),
    Dupe.find(id === undefined ? {} : { $or: [{ a: id }, { b: id }] }, { a: 1, b: 1, shift: 1, "pieces.blocks": 1 }).lean(),
  ]);
  const library = new Set(ready.map((v) => String(v._id)));
  const info = new Map(prints.filter((p) => library.has(String(p.video))).map((p) => [String(p.video), p]));
  const videos = new Map();
  for (const [vid, p] of info) if (!p.error) videos.set(vid, { items: p.items, live: p.live });
  const shared = rels
    .map((r) => ({ a: String(r.a), b: String(r.b), shift: r.shift, pieces: r.pieces }))
    .filter((r) => videos.has(r.a) && videos.has(r.b));
  const kinds = classify(shared, videos, id === undefined ? videos.keys() : [String(id)].filter((vid) => videos.has(vid)));
  const wire = (vid) => {
    const p = info.get(vid);
    if (!p) return { id: vid, kind: "pending" };
    if (p.error) return { id: vid, kind: "unrated", source: p.source, others: [], partners: [] };
    if (!p.matchedAt) return { id: vid, kind: "pending", source: p.source };
    const { kind, coverage, others, partners } = kinds.get(vid);
    return { id: vid, kind, coverage, source: p.source, others, partners };
  };
  if (id !== undefined) {
    if (library.has(String(id))) return wire(String(id));
    return (await Video.exists({ _id: id })) ? { id: String(id), kind: "pending" } : { error: "This video no longer exists." };
  }
  return {
    checked: [...info.values()].filter((p) => p.matchedAt || p.error).length,
    total: library.size,
    videos: Object.fromEntries([...library].map((vid) => [vid, wire(vid)])),
  };
}
