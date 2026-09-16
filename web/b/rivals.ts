// Variant B's rival herds. Workshop issues #55, #63; variant directions
// section 5.4 ("rival herds") with the section 2.7 amendment (a) and 5.5.
//
// One breeder run per run seed: the #21 deme-selection loop, copied from the
// shape of `simulate` in tests/determinism.test.ts (6 demes of 20, 7 random
// duels each, the top 10 breed, 7 carry over, 40 % of pairings chosen for
// divergence, champions migrate by conquest). The rival at stop k is deme
// (k - 1) mod 6 as it stands after generation 2k, and it fields three creatures
// **at random** within the stop's limit (section 2.7 change 1), falling back to
// the whole population when that deme has fewer than three that fit.
//
// Everyone on the same seed meets the same rival herds: nothing here reads a
// player's state. Generations are computed lazily, up to the stop asked for,
// and memoised per seed.

import { founder, breed, int, unit, divergence } from "../../core/index.ts";
import type { Genome, Rng } from "../../core/index.ts";
import { STREAM, stream, duel, fits, tierOf } from "./base.ts";
import type { Limit } from "./base.ts";

export const DEMES = 6, DEME_SIZE = 20, DUELS = 7, WINNERS = 10, CARRY = 7, MIGRANTS = 2, P_OUTCROSS = 0.4;

type Breeder = { r: Rng; demes: Genome[][]; gen: number; snaps: Genome[][][] };
const runs = new Map<number, Breeder>();
const MEMO_SEEDS = 8;

// Selection on (the #21 rival generator) or off (every creature breeds alike:
// the pre-named B1a fallback, kept for measurement only).
export function generation(seed: number, gen: number, selection = true): Genome[][] {
  const key = selection ? seed >>> 0 : -1 - (seed >>> 0);
  let b = runs.get(key);
  if (!b) {
    const r = stream(seed, STREAM.rivals, 0, 0);
    const demes: Genome[][] = [];
    for (let d = 0; d < DEMES; d++) {
      const z = [0, 1, 2, 3].map(() => founder(r));
      while (z.length < DEME_SIZE) z.push(breed(z[int(r, z.length)], z[int(r, z.length)], r).child);
      demes.push(z);
    }
    b = { r, demes, gen: 0, snaps: [demes.map(z => z.slice())] };
    if (runs.size >= MEMO_SEEDS) runs.delete(runs.keys().next().value!);
    runs.set(key, b);
  }
  while (b.gen < gen) step(b, selection);
  return b.snaps[gen];
}

function step(b: Breeder, selection: boolean) {
  const r = b.r;
  const champs: Genome[] = [];
  b.demes = b.demes.map(pool => {
    let order: number[];
    if (selection) {
      const wins = pool.map((c, i) => {
        let w = 0;
        for (let k = 0; k < DUELS; k++) { let j = int(r, pool.length - 1); if (j >= i) j++; if (duel(c, pool[j]) > 0) w++; }
        return w;
      });
      order = pool.map((_, i) => i).sort((x, y) => wins[y] - wins[x] || x - y);
    } else {
      order = pool.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = int(r, i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    }
    const winners = order.slice(0, WINNERS).map(i => pool[i]);
    champs.push(winners[0]);
    const keep = winners.slice(0, CARRY);
    const kids: Genome[] = [];
    while (keep.length + kids.length < DEME_SIZE) {
      let a = int(r, WINNERS), c = int(r, WINNERS - 1); if (c >= a) c++;
      if (unit(r) < P_OUTCROSS) {
        let best = -1;
        for (let k = 0; k < 6; k++) {
          const x = int(r, WINNERS); let y = int(r, WINNERS - 1); if (y >= x) y++;
          const dd = divergence(winners[x], winners[y]);
          if (dd > best) { best = dd; a = x; c = y; }
        }
      }
      kids.push(breed(winners[a], winners[c], r).child);
    }
    return keep.concat(kids);
  });
  if (selection) {
    for (let d = 0; d < DEMES; d++) for (let m = 0; m < MIGRANTS; m++) {
      const e = int(r, DEMES); if (e === d) continue;
      const res = duel(champs[d], champs[e]);
      if (res === 0) continue;
      const [src, dst] = res > 0 ? [d, e] : [e, d];
      b.demes[dst][int(r, DEME_SIZE)] = b.demes[src][int(r, DEME_SIZE)].slice();
    }
  }
  b.gen++;
  b.snaps[b.gen] = b.demes.map(z => z.slice());
}

// The rival herd at a regular stop: up to three distinct creatures, copied, in
// the order drawn (which is not the order they step up in; see run.ts).
export function rivalAt(seed: number, stop: number, limit: Limit, selection = true): Genome[] {
  const demes = generation(seed, 2 * stop, selection);
  const ok = (g: Genome) => fits(limit, tierOf(g));
  let elig = demes[(stop - 1) % DEMES].filter(ok);
  if (elig.length < 3) elig = demes.flat().filter(ok);
  const r = stream(seed, STREAM.rivalPick, stop, 0);
  const idx = elig.map((_, i) => i), n = Math.min(3, elig.length), out: Genome[] = [];
  for (let i = 0; i < n; i++) {
    const j = i + int(r, idx.length - i);
    [idx[i], idx[j]] = [idx[j], idx[i]];
    out.push(elig[idx[i]].slice());
  }
  return out;
}
