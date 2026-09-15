// Variant A's computer opponent. Workshop issues #54, #59; variant directions
// section 3.5; the reference is measure6.py (`choose_pair`, `field`).
//
// It reads a PublicView only -- never the match seed, never the other side's
// pending choice -- plus a seed of its own. Its breeding samples come from a
// stream separate from the round's real litter, so it cannot preview its young.
//
// Difficulty is the softmax temperature and the sample count. Never stats.

import { breed, express, stats, score, rng, unit } from "../../core/index.ts";
import type { Genome, Stats } from "../../core/index.ts";
import { streamSeed } from "./rules.ts";
import type { Pair, PublicView, Side } from "./rules.ts";

export type ComputerOptions = { T: number; samples: number };
export const DEFAULT_COMPUTER: ComputerOptions = { T: 0.25, samples: 4 };

const SAMPLE = 1, FIELD = 2;

const cache = new WeakMap<Genome, Stats>();
const statsOf = (g: Genome): Stats => {
  let s = cache.get(g);
  if (!s) { s = stats(express(g)); cache.set(g, s); }
  return s;
};

// The worst score of g against any of the opponent's creatures.
export function maximin(g: Genome, opp: Genome[]): number {
  const a = statsOf(g);
  let v = Infinity;
  for (const o of opp) { const x = score(a, statsOf(o)); if (x < v) v = x; }
  return v;
}

// For every pair (in order i < j), `samples` private young; the pair's value is
// their mean maximin against the opponent's herd. The first best pair wins.
export function choosePair(v: PublicView, side: Side, cpuSeed: number, o = DEFAULT_COMPUTER): Pair {
  const herd = v.herds[side], opp = v.herds[1 - side];
  const r = rng(streamSeed(cpuSeed, SAMPLE, v.round, side));
  let best: Pair = [0, 1], bestV = -Infinity;
  for (let i = 0; i < herd.length; i++) for (let j = i + 1; j < herd.length; j++) {
    let sum = 0;
    for (let k = 0; k < o.samples; k++) sum += maximin(breed(herd[i], herd[j], r).child, opp);
    const val = sum / o.samples;
    if (val > bestV) { bestV = val; best = [i, j]; }
  }
  return best;
}

// Softmax over the maximin values of its own young against the opponent's
// young, never a pure argmax (T = 0 means argmax, for measurement only).
export function chooseField(v: PublicView, side: Side, cpuSeed: number, o = DEFAULT_COMPUTER): number {
  if (!v.litters) throw new Error("no litter to field from");
  const mine = v.litters[side], theirs = v.litters[1 - side];
  const vals = mine.map(g => maximin(g, theirs));
  let top = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[top]) top = i;
  if (o.T <= 0) return top;
  const w = vals.map(x => expArith((x - vals[top]) / o.T));
  const total = w.reduce((s, x) => s + x, 0);
  let x = unit(rng(streamSeed(cpuSeed, FIELD, v.round, side))) * total;
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
  return w.length - 1;
}

// exp(x) for x <= 0 with + - * / only, so a computer's choice is the same bit
// for bit in every engine (Math.exp is implementation-approximated). Halve x
// until |x| < 0.5, sum the series, then square back.
export function expArith(x: number): number {
  if (x < -700) return 0;
  let k = 0;
  while (x < -0.5 || x > 0.5) { x /= 2; k++; }
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) { term *= x / n; sum += term; if (term === 0) break; }
  for (let i = 0; i < k; i++) sum *= sum;
  return sum;
}
