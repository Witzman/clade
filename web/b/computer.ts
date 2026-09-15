// Variant B's computer expedition: the policy that plays the other run on the
// same seed, and meets the player at the crossings. Workshop issues #55, #63;
// variant directions section 5.5 with the section 2.7 amendments.
//
// A port of measure5.py's heuristic player (H breeding, H lineup, answering):
// it reads matchups with the #21 scorer, never by running a fight. Breeding is
// a fork of server/a/computer.ts's pair chooser (private young per pair, the
// pair with the best mean value wins), with measure5's `value` in place of the
// maximin: predicted wins against the last six rival creatures met plus its own
// herd, discounted for sizes the next three stops will not allow.
//
// Difficulty is the softmax temperature and the sample count. Never stats.

import { breed, unit } from "../../core/index.ts";
import type { Genome, Rng } from "../../core/index.ts";
import { predWin, fits, tierOf, expArith, SHOWN_AHEAD, HERD_CAP, LINEUP, CHOOSE } from "./base.ts";
import type { Limit } from "./base.ts";

export type Policy = { T: number; samples: number };
// T = 0 is argmax, the measured reference policy.
export const REFERENCE_POLICY: Policy = { T: 0, samples: 4 };
export const DEFAULT_POLICY: Policy = { T: 0.08, samples: 4 };

// What the policy knows at a stop: its herd, the rival creatures it has met,
// the route and the stop number (1-based).
export type Context = { herd: Genome[]; seen: Genome[]; route: Limit[]; stop: number };

export function value(g: Genome, c: Context): number {
  const ref = c.seen.slice(-6).concat(c.herd).filter(x => x !== g);
  if (!ref.length) return 0;
  let w = 0;
  for (const x of ref) w += predWin(g, x);
  let v = w / ref.length;
  const ahead = c.route.slice(c.stop, c.stop + SHOWN_AHEAD);
  if (ahead.length) {
    let ok = 0;
    for (const l of ahead) if (fits(l, tierOf(g))) ok++;
    v *= 0.5 + 0.5 * ok / ahead.length;
  }
  return v;
}

// Pairs in order (i < j); each gets `samples` private young from `r`, which
// must not be the stream the real litter comes from. The first best pair wins.
export function choosePair(c: Context, r: Rng, p: Policy): [number, number] {
  const h = c.herd;
  let best: [number, number] = [0, 1], bestV = -Infinity;
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) {
    let sum = 0;
    for (let k = 0; k < p.samples; k++) sum += value(breed(h[i], h[j], r).child, c);
    const v = sum / p.samples;
    if (v > bestV) { bestV = v; best = [i, j]; }
  }
  return best;
}

export function chooseKeep(litter: Genome[], c: Context): number {
  let top = 0, topV = -Infinity;
  litter.forEach((g, i) => { const v = value(g, c); if (v > topV) { topV = v; top = i; } });
  return top;
}

// Indices into c.herd to release, lowest value first, until the herd holds
// HERD_CAP. Values are re-read after each release, since the herd is the
// reference.
export function chooseRelease(c: Context): number[] {
  const left = c.herd.map((_, i) => i), out: number[] = [];
  while (left.length > HERD_CAP) {
    const herd = left.map(i => c.herd[i]);
    let k = 0, kV = Infinity;
    for (let n = 0; n < left.length; n++) {
      const v = value(herd[n], { ...c, herd });
      if (v < kV) { kV = v; k = n; }
    }
    out.push(left.splice(k, 1)[0]);
  }
  return out;
}

// The three founders with the best mean predicted wins against the other five.
export function chooseFounders(six: Genome[]): number[] {
  const sc = six.map(g => {
    let w = 0;
    for (const x of six) if (x !== g) w += predWin(g, x);
    return w;
  });
  return six.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b).slice(0, CHOOSE);
}

// ---------------------------------------------------------------- answering
// The rival sends one creature at a time, uniformly at random from those left,
// and the player answers from the ones it brought. V is (P(win >= 2 of 3),
// expected wins) under a belief matrix PW[mine][theirs] of 0/1, starting from
// `w` wins already banked. Lexicographic: the chance of taking the stop first.
export type Val = [number, number];
const better = (a: Val, b: Val) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const scalar = (v: Val) => v[0] + v[1] / LINEUP;

export function answerValue(PW: number[][], mine: number, theirs: number, w: number,
                            memo = new Map<number, Val>()): Val {
  // mine, theirs: bitmasks of the creatures still to fight (index < 3 each).
  const key = (mine << 8) | (theirs << 4) | w;
  const hit = memo.get(key);
  if (hit) return hit;
  let v: Val;
  if (!mine || !theirs) v = [w >= 2 ? 1 : 0, w];
  else {
    let p = 0, e = 0, n = 0;
    for (let r = 0; r < 3; r++) if (theirs & (1 << r)) {
      let best: Val | null = null;
      for (let m = 0; m < 3; m++) if (mine & (1 << m)) {
        const x = answerValue(PW, mine & ~(1 << m), theirs & ~(1 << r), w + PW[m][r], memo);
        if (!best || better(x, best)) best = x;
      }
      p += best![0]; e += best![1]; n++;
    }
    v = [p / n, e / n];
  }
  memo.set(key, v);
  return v;
}

// Empty slots on either side: a creature facing an empty slot wins, nothing
// changes sides. Wins banked before the first creature steps up.
export const bankedWins = (mine: number, theirs: number) => Math.max(0, mine - theirs);
const mask = (n: number) => (1 << n) - 1;

function pick(vals: Val[], p: Policy, r: Rng | null): number {
  let top = 0;
  for (let i = 1; i < vals.length; i++) if (better(vals[i], vals[top])) top = i;
  if (p.T <= 0 || !r || vals.length < 2) return top;
  const s = vals.map(scalar), w = s.map(x => expArith((x - s[top]) / p.T));
  let x = unit(r) * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
  return w.length - 1;
}

function combos(n: number): number[][] {
  if (n <= LINEUP) return [Array.from({ length: n }, (_, i) => i)];
  const out: number[][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) out.push([a, b, c]);
  return out;
}

// Which three of `eligible` to bring against `rival` (already within the limit).
// Returns indices into `eligible`.
export function chooseThree(eligible: Genome[], rival: Genome[], p: Policy, r: Rng | null): number[] {
  if (!eligible.length) return [];
  const subs = combos(eligible.length);
  const vals = subs.map(S => {
    const PW = S.map(i => rival.map(x => predWin(eligible[i], x)));
    return answerValue(PW, mask(S.length), mask(rival.length), bankedWins(S.length, rival.length));
  });
  return subs[pick(vals, p, r)];
}

// Which of the creatures still standing answers rival creature `r`. `mine`,
// `theirs`: bitmasks over the lineup and the rival herd of what has not fought;
// `w`: wins so far. Returns a lineup index.
export function chooseAnswer(lineup: Genome[], rival: Genome[], mine: number, theirs: number, w: number,
                             rv: number, p: Policy, r: Rng | null): number {
  const PW = lineup.map(g => rival.map(x => predWin(g, x)));
  const memo = new Map<number, Val>();
  const cand: number[] = [], vals: Val[] = [];
  for (let m = 0; m < lineup.length; m++) if (mine & (1 << m)) {
    cand.push(m);
    vals.push(answerValue(PW, mine & ~(1 << m), theirs & ~(1 << rv), w + PW[m][rv], memo));
  }
  return cand[pick(vals, p, r)];
}

// What one side expects the other to bring: its eligible creatures with the
// best mean predicted wins against this side's eligible creatures.
export function predictedThree(theirs: Genome[], mine: Genome[]): Genome[] {
  const sc = theirs.map(g => {
    let w = 0;
    for (const x of mine) w += predWin(g, x);
    return mine.length ? w / mine.length : 0;
  });
  return theirs.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b).slice(0, LINEUP).map(i => theirs[i]);
}
