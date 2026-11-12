import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { BLOCK, RATE, LIMITS, popcount, blockStarts, overlap, ber, staticRatio, liveBlocks, pieces, buildIndex, vote, match, matchAll, classify } from "./dupeMatch.js";

// deterministic pseudo-random fingerprints (mulberry32)
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const noise = (length, seed) => Uint32Array.from({ length }, random(seed));
const join = (...parts) => {
  const out = new Uint32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};
// flips about `share` of the bits, like a quieter or re-encoded copy
const blur = (fp, share, seed) => {
  const next = random(seed);
  return fp.map((x) => {
    let mask = 0;
    for (let bit = 0; bit < 32; bit++) if (next() / 2 ** 32 < share) mask |= 1 << bit;
    return (x ^ mask) >>> 0;
  });
};
const minutes = (n) => Math.round(n * 60 * RATE);
const describe = (fps) => new Map(Object.entries(fps).map(([id, fp]) => [id, { items: fp.length, live: liveBlocks(fp) }]));
// what the library would find, adding the videos in this order
const library = (fps) => {
  const ids = Object.keys(fps);
  const rels = matchAll(Object.values(fps), ids.map((_, i) => i)).flatMap(({ query, rels }) =>
    rels.map((r) => ({ a: ids[query], b: ids[r.ref], shift: r.shift, pieces: r.pieces })),
  );
  return { rels, kinds: classify(rels, describe(fps)) };
};

// bit counting
assert.equal(popcount(0), 0);
assert.equal(popcount(0xffffffff), 32);
assert.equal(popcount(0x80000001), 2);
assert.equal(ber(Uint32Array.of(0, 0xffffffff), Uint32Array.of(0xffffffff, 0xffffffff)), 0.5);

// blocks: back to back, the last one flush with the end
assert.deepEqual(blockStarts(100, 30), [0, 30, 60, 70]);
assert.deepEqual(blockStarts(90, 30), [0, 30, 60]);
assert.deepEqual(blockStarts(29, 30), []);
assert.deepEqual(overlap(100, 100, 40, 30), [0, 30]);
assert.deepEqual(overlap(100, 100, -40, 30), [40, 70]);
assert.equal(overlap(100, 100, 80, 30), null);

// silence: values that never change
assert.deepEqual(staticRatio(new Uint32Array(BLOCK).fill(627964279), [0]), [0]);
assert.ok(staticRatio(noise(BLOCK, 1), [0])[0] > 0.4);
assert.deepEqual(liveBlocks(join(noise(BLOCK, 2), new Uint32Array(BLOCK))), [0]);

// pieces: one bad block doesn't split a run, two do; NaN is skipped; short runs don't count
const at = (n) => Array.from({ length: n }, (_, i) => i * 10);
assert.deepEqual(pieces(at(5), [0.1, 0.1, 0.5, 0.1, 0.1], 0.3, 2, 10, 0).map((p) => [p.a0, p.a1, p.blocks.length]), [[0, 50, 4]]);
assert.deepEqual(pieces(at(6), [0.1, 0.1, 0.5, 0.5, 0.1, 0.1], 0.3, 2, 10, 0).map((p) => [p.a0, p.a1]), [[0, 20], [40, 60]]);
assert.deepEqual(pieces(at(4), [0.1, NaN, NaN, 0.1], 0.3, 2, 10, 5).map((p) => [p.a0, p.a1, p.b0, p.b1]), [[0, 40, 5, 45]]);
assert.deepEqual(pieces(at(3), [0.1, 0.5, 0.5], 0.3, 2, 10, 0), []);
// two blocks that overlap cover less than two blocks' length
assert.deepEqual(pieces([0, 5], [0.1, 0.1], 0.3, 2, 10, 0), []);
assert.deepEqual(pieces(at(3), [0.9, 0.9, 0.2], 0.5, 2, 10, 0, false).map((p) => p.blocks), [[0, 10]]);

// a copy inside a longer video is found at its offset
{
  const host = noise(minutes(10), 3);
  const copy = host.slice(1000, 1000 + minutes(3));
  const index = buildIndex([host, copy]);
  assert.deepEqual(vote(index, copy, 1).map((v) => [v.ref, v.shift]), [[0, 1000]]);
  const [rel] = match(index, copy, 1);
  assert.equal(rel.shift, 1000);
  assert.equal(rel.ber, 0);
  assert.deepEqual(rel.pieces.map((p) => [p.a0, p.a1, p.b0, p.b1]), [[0, copy.length, 1000, 1000 + copy.length]]);
}

// a copy cut two values later, and a blurred one, still match
{
  const original = noise(minutes(6), 4);
  const { rels } = library({ original, later: original.slice(2), blurred: blur(original, 0.12, 5) });
  const found = (a, b) => rels.find((r) => r.a === a && r.b === b);
  assert.equal(found("later", "original").shift, 2);
  assert.equal(found("blurred", "original").shift, 0);
  assert.ok(found("blurred", "original").pieces[0].ber > 0.05);
}

// a 3-minute clip of an episode: the clip is inside it, the episode contains it
{
  const episode = noise(minutes(11), 6);
  const { rels, kinds } = library({ episode, clip: episode.slice(minutes(4), minutes(7)) });
  assert.equal(rels.length, 1);
  assert.equal(kinds.get("clip").kind, "inside");
  assert.deepEqual(kinds.get("clip").others, ["episode"]);
  assert.equal(kinds.get("clip").coverage, 1);
  assert.equal(kinds.get("episode").kind, "contains");
  assert.deepEqual(kinds.get("clip").partners, [{ id: "episode", here: [0, 180], there: 240, seconds: 180 }]);
}

// three episodes and a compilation of the three: the compilation is covered by them, each is inside it
{
  const one = noise(minutes(4.2), 7);
  const two = noise(minutes(3.9), 8);
  const three = noise(minutes(4.5), 9);
  const { kinds } = library({ one, two, three, compilation: join(one, two, three) });
  const compilation = kinds.get("compilation");
  assert.equal(compilation.kind, "covered");
  assert.deepEqual(compilation.others, ["one", "three", "two"]);
  assert.equal(compilation.coverage, 1);
  assert.equal(compilation.partners.length, 3);
  for (const id of ["one", "two", "three"]) {
    assert.equal(kinds.get(id).kind, "inside");
    assert.deepEqual(kinds.get(id).others, ["compilation"]);
  }
  assert.deepEqual(kinds.get("two").partners[0].there, Math.round(one.length / RATE));
}

// the same video saved twice
{
  const first = noise(minutes(8), 10);
  const { kinds } = library({ first, second: first.slice() });
  assert.equal(kinds.get("first").kind, "same");
  assert.equal(kinds.get("second").kind, "same");
}

// two episodes sharing five minutes: partial; sharing 2.5 minutes: short
{
  const shared = noise(minutes(5), 11);
  const { kinds } = library({ a: join(noise(minutes(6), 12), shared), b: join(shared, noise(minutes(7), 13)) });
  assert.equal(kinds.get("a").kind, "partial");
  assert.equal(kinds.get("b").kind, "partial");
  const bit = noise(minutes(2.5), 14);
  const short = library({ a: join(noise(minutes(6), 15), bit), b: join(bit, noise(minutes(7), 16)) }).kinds;
  assert.equal(short.get("a").kind, "short");
}

// the same 65-second opening on two different episodes isn't a match
{
  const opening = noise(Math.round(65 * RATE), 17);
  const { rels, kinds } = library({ a: join(opening, noise(minutes(10), 18)), b: join(opening, noise(minutes(11), 19)) });
  assert.deepEqual(rels, []);
  assert.equal(kinds.get("a").kind, "none");
}

// silence matches nothing and can't be rated, not even against other silence
{
  const { rels, kinds } = library({ quiet: new Uint32Array(minutes(3)).fill(627964279), quieter: new Uint32Array(minutes(4)).fill(627964279) });
  assert.deepEqual(rels, []);
  assert.equal(kinds.get("quiet").kind, "unrated");
  assert.equal(kinds.get("quieter").kind, "unrated");
}

// a 90-second video is too short to rate, even when another video has it
{
  const episode = noise(minutes(10), 20);
  const { kinds } = library({ episode, teaser: episode.slice(0, Math.round(90 * RATE)) });
  assert.equal(kinds.get("teaser").kind, "unrated");
  assert.equal(kinds.get("episode").kind, "none");
}

// a pair is found once, by the newer video
{
  const episode = noise(minutes(5), 21);
  const fps = [episode, noise(minutes(5), 22), episode.slice()];
  assert.deepEqual(matchAll(fps, [0, 1, 2]).map((r) => r.rels.map((x) => x.ref)), [[], [], [0]]);
  assert.deepEqual(matchAll(fps, [2]).map((r) => r.query), [2]);
}

// a value that's everywhere doesn't vote
{
  const jingle = new Uint32Array(LIMITS.maxHits + 1).fill(12345);
  assert.deepEqual(vote(buildIndex([jingle]), jingle), []);
}

// the worker thread answers like matchAll
{
  const episode = noise(minutes(5), 23);
  const fps = [episode, join(noise(minutes(2), 24), episode)];
  const worker = new Worker(new URL("./dupeMatch.js", import.meta.url), { workerData: "dupeMatch" });
  const answer = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.postMessage({ fps, queries: [1] });
  });
  assert.deepEqual(answer, matchAll(fps, [1]));
  assert.equal(answer[0].rels[0].shift, -minutes(2));
}

console.log("dupe match ok");
