// Variant B's shared constants, weight limits, seeded streams and the two ways
// a matchup is read (the scorer, and the real fight). Workshop issues #55, #63;
// variant directions section 5.4 with the section 2.7 amendments.
//
// Pure: no IO, no DOM, no clock, no engine randomness. Variants never import
// each other, so the stream mixer below is a fork of server/a/rules.ts, not an
// import of it.

import { rng, express, stats, score, fight, fightResult } from "../../core/index.ts";
import type { Genome, Rng, Stats } from "../../core/index.ts";

export const DEAL = 6;          // founders dealt by the run seed
export const CHOOSE = 3;        // founders the player keeps
export const STOPS = 9;
export const LITTER = 3;
export const HERD_CAP = 8;
export const LINEUP = 3;
export const SHOWN_AHEAD = 3;   // the next three stops' limits are always shown
export const MIN_HERD = 2;      // below this the expedition ends

export const isCrossing = (stop: number) => stop === 3 || stop === 6 || stop === 9;

// Size tiers are 0 tiny, 1 small, 2 medium, 3 big, 4 huge.
export const LIMITS = ["any", "medium-or-smaller", "small-or-smaller", "medium-or-larger", "big-or-larger"] as const;
export type Limit = typeof LIMITS[number];
export function fits(limit: Limit, tier: number): boolean {
  switch (limit) {
    case "any": return true;
    case "medium-or-smaller": return tier <= 2;
    case "small-or-smaller": return tier <= 1;
    case "medium-or-larger": return tier >= 2;
    case "big-or-larger": return tier >= 3;
  }
}

// ---------------------------------------------------------------- streams
export const STREAM = {
  route: 1, deal: 2, litter: 3, rivals: 4, rivalPick: 5, order: 6,
  cpuSample: 7, cpuChoice: 8,
} as const;

// A 32-bit seed for stream (kind, a, b) of `seed`. Integer mixing only.
// Fork of server/a/rules.ts streamSeed.
export function streamSeed(seed: number, kind: number, a: number, b: number): number {
  let h = 0x811c9dc5;
  for (const x of [seed, kind, a, b]) {
    const v = x >>> 0;
    for (let i = 0; i < 4; i++) h = Math.imul(h ^ ((v >>> (i * 8)) & 255), 0x01000193);
  }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
export const stream = (seed: number, kind: number, a: number, b: number): Rng => rng(streamSeed(seed, kind, a, b));

// FNV-1a over genome bytes: "the herd at that moment", as a 32-bit number.
export function herdKey(gs: Genome[]): number {
  let h = 0x811c9dc5;
  for (const g of gs) for (let i = 0; i < g.length; i++) h = Math.imul(h ^ g[i], 0x01000193);
  return h >>> 0;
}

// ---------------------------------------------------------------- reading a matchup
const cache = new WeakMap<Genome, { s: Stats; tier: number }>();
function entry(g: Genome) {
  let e = cache.get(g);
  if (!e) { const p = express(g); e = { s: stats(p), tier: p.tier }; cache.set(g, e); }
  return e;
}
export const statsOf = (g: Genome): Stats => entry(g).s;
export const tierOf = (g: Genome): number => entry(g).tier;

// What a skilled player reads from the counters: 1 if the scorer favours a.
// An empty opponent slot is a win; an empty own slot is not.
export function predWin(a: Genome | null, b: Genome | null): number {
  if (a === null) return 0;
  if (b === null) return 1;
  const sa = statsOf(a), sb = statsOf(b);
  return score(sa, sb) > score(sb, sa) ? 1 : 0;
}

// The real fight: 1 a wins, -1 b wins, 0 a draw.
export function duel(a: Genome, b: Genome): number {
  return fightResult(fight(statsOf(a), statsOf(b)));
}

// exp(x) for x <= 0 with + - * / only, so a softmax choice is the same bit for
// bit in every engine. Fork of server/a/computer.ts expArith.
export function expArith(x: number): number {
  if (x < -700) return 0;
  let k = 0;
  while (x < -0.5 || x > 0.5) { x /= 2; k++; }
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) { term *= x / n; sum += term; if (term === 0) break; }
  for (let i = 0; i < k; i++) sum *= sum;
  return sum;
}
