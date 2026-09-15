// Divergence: how unalike two creatures are as breeding stock, the number the
// breeding screen shows for a selected pair. Workshop issues #21, #57 (plan
// section 0), #59.
//
// Ported byte for byte from `distance` in tests/determinism.test.ts (which
// keeps its own copy, so no golden hash moves): the mean absolute difference
// over every body system, both copies and every axis, plus 42 for every body
// system whose first copy has a different form, averaged over the systems.

import { NL, NA, form, vecAt } from "./genome.ts";
import type { Genome } from "./genome.ts";

export function divergence(a: Genome, b: Genome): number {
  let d = 0, mm = 0;
  for (let l = 0; l < NL; l++) {
    if (form(a, l, 0) !== form(b, l, 0)) mm++;
    for (let s = 0; s < 2; s++) for (let x = 0; x < NA; x++) d += Math.abs(vecAt(a, l, s, x) - vecAt(b, l, s, x));
  }
  return d / (NL * 2 * NA) + 42 * mm / NL;
}
