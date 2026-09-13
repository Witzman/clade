// Genome -> phenotype -> combat stats. Workshop issues #21, #23.

import {
  NL, NA, SIZE_L, DOM, KLEIBER, SPEED_POW, COST_POW, P, CB, LEAD_SUPPORT,
  form, depth, aseed, vecAt,
} from "./genome.ts";
import type { Genome } from "./genome.ts";

export type Phenotype = { v: Float64Array; expr: Int8Array; tier: number; F: number; budget: number };

export function express(g: Genome): Phenotype {
  const expr = new Int8Array(NL);
  for (let l = 0; l < NL; l++) {
    const d0 = DOM[l][form(g, l, 0)], d1 = DOM[l][form(g, l, 1)];
    if (d0 !== d1) expr[l] = d0 > d1 ? 0 : 1;
    else if (depth(g, l, 0) !== depth(g, l, 1)) expr[l] = depth(g, l, 0) > depth(g, l, 1) ? 0 : 1;
    else expr[l] = aseed(g, l, 0) >= aseed(g, l, 1) ? 0 : 1;
  }
  const tier = form(g, SIZE_L, expr[SIZE_L]);
  let homo = 0;
  for (let l = 0; l < NL; l++) if (form(g, l, 0) === form(g, l, 1)) homo++;
  const F = homo / NL;
  const budget = P.budget_base * KLEIBER[tier] * (1 - P.inbreed * F);
  const v = new Float64Array(NA);
  for (let a = 0; a < NA; a++) {
    let lead = 0, pos = 0, neg = 0;
    for (let l = 0; l < NL; l++) {
      const x = vecAt(g, l, expr[l], a);
      if (x > 0) { pos += x; if (x > lead) lead = x; } else neg += x;
    }
    v[a] = lead + LEAD_SUPPORT * (pos - lead) + neg;
  }
  let load = 0;
  for (let a = 0; a < NA; a++) load += Math.abs(v[a]);
  if (load > budget) for (let a = 0; a < NA; a++) v[a] *= budget / load;
  return { v, expr, tier, F, budget };
}

export type Stats = { M: number; R: number; E: number; T: number; S: number; hp: number;
  stam: number; regen: number; speed: number; cost: number };

export function stats(p: Phenotype): Stats {
  const [M, R, E, T, S] = Array.from(p.v, x => Math.max(0, x));
  const l1 = M + R + E + T + S;
  const conc = (M * M + R * R + E * E + T * T + S * S) / Math.max(l1, 1);
  return {
    M, R, E, T, S,
    hp: CB.hp_base + CB.hp_l1 * l1 + CB.hp_m * M,
    stam: 90 + 0.7 * T + 0.4 * M,
    regen: 0.35 + 0.020 * T,
    speed: (0.55 + T / CB.speed_t) * SPEED_POW[p.tier],
    cost: (0.8 + CB.c_l1 * l1 + CB.c_spec * conc) * COST_POW[p.tier],
  };
}
