// The #21 matchup scorer: what a player reads from the counters, without
// running the fight. Workshop issues #21, #57 (plan section 0), #59.
//
// score(a, b) > score(b, a) predicts that a beats b. It is the model, not a
// variant rule: every computer opponent and every "who is favoured" display
// reads it. Reference: measure.py `dmg` and `score` in the workshop.
//
// `hit` is one fresh (not out-of-breath) strike of a on d -- the rule of `strike` in fight.ts
// with the out-of-breath flag off. It is copied here rather than exported from
// fight.ts so that no golden hash can move; tests/a-rules.test.ts holds the
// copy to the fight by checking that the scorer predicts fight() winners.

import { CB } from "./genome.ts";
import type { Stats } from "./express.ts";

const gate = (o: number, d: number, k: number) => Math.max(0, Math.min(1, (o - k * d) / (0.5 * o + 1)));

export function hit(a: Stats, d: Stats): number {
  const x = CB.aE * a.E * gate(a.E, d.S, CB.kE) + CB.aM * a.M * gate(a.M, d.T, CB.kM)
          + CB.aT * a.T * gate(a.T, d.M, CB.kT) + 1;
  return Math.max(0.5, x - CB.flat_shell * d.S);
}

// Higher is better for a. Not symmetric: compare score(a, b) with score(b, a).
export function score(a: Stats, b: Stats): number {
  return hit(a, b) / hit(b, a) + 0.02 * (a.R - b.R) + 0.002 * a.hp;
}
