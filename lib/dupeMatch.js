import { isMainThread, parentPort, workerData } from "node:worker_threads";

// Finds the same audio in Chromaprint fingerprints (fpcalc -raw: a 32-bit value about every eighth
// of a second): which stretches of a video play again in another one, and where. Videos are
// compared one minute (a block) at a time; a shared piece is two or more blocks in a row whose
// values differ in few enough bits. Pure functions; lib/dupes.js runs matchAll in a worker thread.

// fpcalc's default algorithm reads 11025 Hz audio and gives a value every 1365 samples
export const RATE = 11025 / 1365;
// one minute, in values
export const BLOCK = Math.round(60 * RATE);

// Measured on a real library: blocks of the same audio stayed under 0.22 differing bits, unrelated
// blocks above 0.39; the limit sits halfway.
export const LIMITS = {
  // share of differing bits under which a block counts as the same audio
  maxBer: 0.3067,
  // values an offset needs in common before its blocks are compared
  minVotes: 16,
  // a value found more often than this in the library (silence, a jingle) doesn't vote
  maxHits: 64,
  // a block whose values barely change (digital silence) can't be compared
  minChange: 0.05,
  // offsets this close (in values) are counted together: two cuts rarely land on the same sample
  spread: 3,
  // a shared piece is at least two blocks long
  minBlocks: 2,
  // share of a video that makes it the same as, inside or covered by other videos
  share: 0.9,
  // a shorter shared piece is an opening or closing jingle rather than the same episode
  longSeconds: 180,
  // a video with fewer blocks of sound can't be rated
  minRatedBlocks: 3,
};

// vote keys: video * SPAN + offset + HALF (offsets up to about 36 hours either way)
const SPAN = 2 ** 21;
const HALF = 2 ** 20;

export function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

// Where the blocks of a fingerprint `length` values long start: back to back, the last one flush with the end.
export function blockStarts(length, bl = BLOCK) {
  if (length < bl) return [];
  const starts = [];
  for (let x = 0; x <= length - bl; x += bl) starts.push(x);
  if (starts.at(-1) + bl < length) starts.push(length - bl);
  return starts;
}

// a[i] lines up with b[i + shift]: the blocks (in a) of the stretch both cover, or null when it's shorter than a block.
export function overlap(la, lb, shift, bl = BLOCK) {
  const i0 = Math.max(0, -shift);
  const i1 = Math.min(la, lb - shift);
  if (i1 - i0 < bl) return null;
  return blockStarts(i1 - i0, bl).map((x) => x + i0);
}

// Share of differing bits between two runs of values of the same length.
export function ber(a, b) {
  let bits = 0;
  for (let i = 0; i < a.length; i++) bits += popcount((a[i] ^ b[i]) >>> 0);
  return bits / a.length / 32;
}

// How much the values change from one to the next inside each block (0 = the same value throughout).
export function staticRatio(fp, starts, bl = BLOCK) {
  return starts.map((s) => {
    const e = Math.min(s + bl - 1, fp.length - 1);
    let bits = 0;
    for (let i = s; i < e; i++) bits += popcount((fp[i] ^ fp[i + 1]) >>> 0);
    return bits / 32 / Math.max(e - s, 1);
  });
}

// The blocks of a fingerprint that have sound to compare.
export function liveBlocks(fp, bl = BLOCK) {
  const starts = blockStarts(fp.length, bl);
  const change = staticRatio(fp, starts, bl);
  return starts.filter((_, j) => change[j] >= LIMITS.minChange);
}

// Runs of matching blocks: a single bad block doesn't split a run, NaN (silence) is skipped, and
// a run needs minBlocks blocks covering at least minBlocks * bl values.
export function pieces(starts, scores, limit, minBlocks = LIMITS.minBlocks, bl = BLOCK, shift = 0, lowerIsBetter = true) {
  const out = [];
  let run = [];
  let misses = 0;
  const close = () => {
    if (run.length < minBlocks) return;
    const blocks = run.map((j) => starts[j]);
    let length = bl;
    for (let q = 0; q < blocks.length - 1; q++) length += Math.min(bl, blocks[q + 1] - blocks[q]);
    if (length < minBlocks * bl) return;
    const score = run.reduce((sum, j) => sum + scores[j], 0) / run.length;
    const a0 = blocks[0];
    const a1 = blocks.at(-1) + bl;
    out.push({ a0, a1, b0: a0 + shift, b1: a1 + shift, ber: Math.round(score * 1e4) / 1e4, blocks });
  };
  for (let j = 0; j < scores.length; j++) {
    const x = scores[j];
    if (Number.isNaN(x)) continue;
    if (lowerIsBetter ? x <= limit : x >= limit) {
      run.push(j);
      misses = 0;
    } else if (run.length && ++misses >= 2) {
      close();
      run = [];
      misses = 0;
    }
  }
  close();
  return out;
}

const lowerBound = (list, x, lo = 0) => {
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (list[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
};

const upperBound = (list, x, lo = 0) => {
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (list[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
};

// Every value of every fingerprint, sorted, with the fingerprint and position it came from.
export function buildIndex(fps) {
  const total = fps.reduce((n, fp) => n + fp.length, 0);
  const keys = new BigUint64Array(total);
  const owner = new Int32Array(total);
  const at = new Int32Array(total);
  let g = 0;
  fps.forEach((fp, v) => {
    for (let i = 0; i < fp.length; i++, g++) {
      keys[g] = (BigInt(fp[i]) << 32n) | BigInt(g);
      owner[g] = v;
      at[g] = i;
    }
  });
  keys.sort();
  const values = new Uint32Array(total);
  const video = new Int32Array(total);
  const position = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const j = Number(keys[i] & 0xffffffffn);
    values[i] = Number(keys[i] >> 32n);
    video[i] = owner[j];
    position[i] = at[j];
  }
  return { fps, values, video, position };
}

// The offsets at which q shares enough values with each indexed fingerprint (own: q's own index, skipped):
// [{ ref, shift, votes }], one per group of nearby offsets, at the offset with the most votes.
export function vote(index, q, own = -1) {
  const { values, video, position } = index;
  const votes = new Map();
  for (let i = 0; i < q.length; i++) {
    const lo = lowerBound(values, q[i]);
    const hi = upperBound(values, q[i], lo);
    if (hi === lo || hi - lo > LIMITS.maxHits) continue;
    for (let m = lo; m < hi; m++) {
      if (video[m] === own) continue;
      const key = video[m] * SPAN + (position[m] - i + HALF);
      votes.set(key, (votes.get(key) || 0) + 1);
    }
  }
  const keys = [...votes.keys()].sort((x, y) => x - y);
  const sums = new Float64Array(keys.length + 1);
  keys.forEach((k, i) => (sums[i + 1] = sums[i] + votes.get(k)));
  const groups = [];
  for (const k of keys) {
    const near = sums[upperBound(keys, k + LIMITS.spread)] - sums[lowerBound(keys, k - LIMITS.spread)];
    if (near < LIMITS.minVotes) continue;
    const ref = Math.floor(k / SPAN);
    const shift = (k % SPAN) - HALF;
    const group = groups.at(-1);
    if (group && group.ref === ref && shift - group.last <= LIMITS.spread) {
      group.last = shift;
      if (near > group.votes) Object.assign(group, { shift, votes: near });
    } else {
      groups.push({ ref, shift, last: shift, votes: near });
    }
  }
  return groups.map(({ ref, shift, votes }) => ({ ref, shift, votes }));
}

// Block by block bit error rates of q against ref at one offset; NaN where either side is silent.
function blockBers(q, ref, shift, starts) {
  const cq = staticRatio(q, starts);
  const cr = staticRatio(ref, starts.map((s) => s + shift));
  return starts.map((s, j) => {
    if (cq[j] < LIMITS.minChange || cr[j] < LIMITS.minChange) return NaN;
    return ber(q.subarray(s, s + BLOCK), ref.subarray(s + shift, s + shift + BLOCK));
  });
}

// What q shares with the indexed fingerprints: [{ ref, shift, ber, votes, pieces }], where
// q[i] lines up with fps[ref][i + shift] and pieces are in q's values.
export function match(index, q, own = -1) {
  const found = new Map();
  for (const { ref, shift: center, votes } of vote(index, q, own)) {
    const fp = index.fps[ref];
    let best;
    // the votes point near the offset; the bits pick the exact one
    for (let shift = center - 1; shift <= center + 1; shift++) {
      const starts = overlap(q.length, fp.length, shift);
      if (!starts) continue;
      const bers = blockBers(q, fp, shift, starts);
      const rated = bers.filter((x) => !Number.isNaN(x));
      const mean = rated.length ? rated.reduce((sum, x) => sum + x, 0) / rated.length : 1;
      if (!best || mean < best.mean) best = { mean, shift, starts, bers };
    }
    if (!best) continue;
    const shared = pieces(best.starts, best.bers, LIMITS.maxBer, LIMITS.minBlocks, BLOCK, best.shift);
    const key = `${ref}:${best.shift}`;
    if (shared.length && !found.has(key)) {
      found.set(key, { ref, shift: best.shift, ber: Math.round(best.mean * 1e4) / 1e4, votes, pieces: shared });
    }
  }
  return [...found.values()];
}

// fps: every fingerprint, oldest video first; queries: indexes of the ones to compare.
// Each is compared only with older ones, so a pair is found once, by the newer video: [{ query, rels }].
export function matchAll(fps, queries) {
  const index = buildIndex(fps);
  return queries.map((query) => ({ query, rels: match(index, fps[query], query).filter((r) => r.ref < query) }));
}

const uniq = (ids) => [...new Set(ids)].sort();
const seconds = (values) => Math.round(values / RATE);

// Values covered by blocks starting at `starts`, as a mask over a fingerprint `items` long.
function cover(mask, starts) {
  for (const s of starts) mask.fill(1, Math.max(0, s), s + BLOCK);
  return mask;
}

const span = (blocks) => {
  let length = BLOCK;
  for (let q = 0; q < blocks.length - 1; q++) length += Math.min(BLOCK, blocks[q + 1] - blocks[q]);
  return length;
};

// Sums up what each video shares with the others.
// rels: [{ a, b, shift, pieces: [{ blocks }] }] (blocks: where each matching block starts in a);
// videos: Map of id → { items, live } (fingerprint length and liveBlocks()); ids: the videos to sum up.
// Returns a Map of id → { kind, coverage, others, partners }:
//   kind: same | inside (all of it is in another video) | covered (all of it is spread over others)
//         | contains (another video is all in it) | partial (3+ minutes shared) | short | none | unrated
//   coverage: share of its sound found in other videos; others: the videos behind the kind;
//   partners: every shared piece, longest first: { id, here: [from, to], there, seconds } (seconds).
export function classify(rels, videos, ids = videos.keys()) {
  const byVideo = new Map();
  const add = (id, entry) => (byVideo.get(id) || byVideo.set(id, []).get(id)).push(entry);
  rels.forEach((rel) => {
    add(rel.a, { rel, side: 0 });
    add(rel.b, { rel, side: 1 });
  });

  const sound = new Map();
  const soundOf = (id) => {
    if (!sound.has(id)) {
      const { items, live } = videos.get(id);
      const mask = cover(new Uint8Array(items), live);
      sound.set(id, { mask, count: mask.reduce((n, x) => n + x, 0) });
    }
    return sound.get(id);
  };
  const blocksOf = (rel, side) => {
    const starts = rel.pieces.flatMap((p) => p.blocks);
    return side ? starts.map((s) => s + rel.shift) : starts;
  };
  // share of a video's sound covered by some of its relations
  const share = (id, list) => {
    const { mask: live, count } = soundOf(id);
    if (!count) return 0;
    const mask = new Uint8Array(live.length);
    for (const { rel, side } of list) cover(mask, blocksOf(rel, side));
    let covered = 0;
    for (let i = 0; i < mask.length; i++) covered += mask[i] & live[i];
    return covered / count;
  };
  const pairs = new Map();
  const pairShare = (rel) => {
    if (!pairs.has(rel)) pairs.set(rel, [share(rel.a, [{ rel, side: 0 }]), share(rel.b, [{ rel, side: 1 }])]);
    return pairs.get(rel);
  };
  const longest = (rel) => Math.max(...rel.pieces.map((p) => span(p.blocks))) / RATE;

  const out = new Map();
  for (const id of ids) {
    const { live } = videos.get(id);
    const list = byVideo.get(id) || [];
    const coverage = list.length ? share(id, list) : 0;
    const partners = [];
    for (const { rel, side } of list) {
      for (const p of rel.pieces) {
        const a0 = p.blocks[0];
        const a1 = p.blocks.at(-1) + BLOCK;
        const [from, to, there] = side ? [a0 + rel.shift, a1 + rel.shift, a0] : [a0, a1, a0 + rel.shift];
        partners.push({ id: side ? rel.a : rel.b, here: [seconds(from), seconds(to)], there: seconds(there), seconds: seconds(to - from) });
      }
    }
    partners.sort((x, y) => y.seconds - x.seconds);
    const all = uniq(list.map(({ rel, side }) => (side ? rel.a : rel.b)));
    let kind;
    let others = all;
    if (live.length < LIMITS.minRatedBlocks) {
      kind = "unrated";
      others = [];
    } else if (!list.length) {
      kind = "none";
    } else {
      const same = [];
      const inside = [];
      const contains = [];
      for (const { rel, side } of list) {
        const [ra, rb] = pairShare(rel);
        const [mine, theirs] = side ? [rb, ra] : [ra, rb];
        const other = side ? rel.a : rel.b;
        if (mine >= LIMITS.share && theirs >= LIMITS.share) same.push(other);
        else if (mine >= LIMITS.share) inside.push(other);
        else if (theirs >= LIMITS.share) contains.push(other);
      }
      if (same.length) [kind, others] = ["same", uniq(same)];
      else if (inside.length) [kind, others] = ["inside", uniq(inside)];
      else if (coverage >= LIMITS.share) kind = "covered";
      else if (contains.length) [kind, others] = ["contains", uniq(contains)];
      else kind = Math.max(...list.map(({ rel }) => longest(rel))) >= LIMITS.longSeconds ? "partial" : "short";
    }
    out.set(id, { kind, coverage: Math.round(coverage * 1000) / 1000, others, partners });
  }
  return out;
}

// Started by lib/dupes.js as a worker thread, so comparing never holds up the server.
if (!isMainThread && workerData === "dupeMatch") {
  parentPort.once("message", ({ fps, queries }) => parentPort.postMessage(matchAll(fps, queries)));
}
