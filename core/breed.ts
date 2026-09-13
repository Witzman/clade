// Breeding, fusion, mutation and founders. Workshop issues #21, #23.

import { int, normal, uniform, unit } from "./rng.ts";
import type { Rng } from "./rng.ts";
import {
  NL, NA, NM, GENOME_B, NO_GRAFT, DOM, MASK_IDX, MASK, P,
  form, graft, depth, vecAt, writeAllele, clampV,
} from "./genome.ts";
import type { Genome } from "./genome.ts";

export type Fusion = { system: number; formA: number; formB: number; disputed: number; moved: number; by: number };

function fuse(va: number[], ma: number, vb: number[], mb: number, l: number, r: Rng, reg: Fusion[]): number[] {
  const d = va.map((x, i) => x - vb[i]);
  const base = va.map((x, i) => (x + vb[i]) / 2);
  const key = (ma * 31 + mb * 7 + l * 101 + int(r, 4)) % (NA * 2);
  let shift = key % NA;
  const sign = key < NA ? 1 : -1;
  if (shift === 0) shift = 1;
  const idx = MASK_IDX[l];
  const k = shift % 3 || 1; // np.roll(x, k): out[i] = x[(i - k) mod 3]
  const red = [0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) red[idx[i]] = d[idx[(i - k + 3) % 3]] * P.fuse_gain * sign;
  let raw = base.map((x, i) => x + red[i]);
  let l1 = raw.reduce((s, x) => s + Math.abs(x), 0);
  const target = (va.reduce((s, x) => s + Math.abs(x), 0) + vb.reduce((s, x) => s + Math.abs(x), 0)) / 2 * P.fuse_vigour;
  if (l1 < 1e-6) {
    raw = red.reduce((s, x) => s + Math.abs(x), 0) > 1e-6 ? red : va.slice();
    l1 = Math.max(raw.reduce((s, x) => s + Math.abs(x), 0), 1e-6);
  }
  const out = raw.map(x => clampV(x * target / l1));
  let moved = 0, disputed = 0;
  for (let i = 1; i < NA; i++) {
    if (Math.abs(out[i] - base[i]) > Math.abs(out[moved] - base[moved])) moved = i;
    if (Math.abs(d[i]) > Math.abs(d[disputed])) disputed = i;
  }
  reg.push({ system: l, formA: ma, formB: mb, disputed, moved, by: d.reduce((s, x) => s + Math.abs(x), 0) / NA });
  return out;
}

function mutate(vec: number[], m: number, l: number, r: Rng): [number[], number] {
  if (unit(r) < P.mut_morph_p) m = int(r, NM);
  if (unit(r) < P.mut_p) {
    const v = vec.slice();
    const l1 = v.reduce((s, x) => s + Math.abs(x), 0);
    const i = MASK_IDX[l][int(r, 3)];
    v[i] += normal(r, 20);
    const nl1 = v.reduce((s, x) => s + Math.abs(x), 0);
    if (nl1 > 1e-6) { const k = l1 * uniform(r, 0.94, 1.05) / nl1; for (let a = 0; a < NA; a++) v[a] *= k; }
    vec = v.map((x, a) => (MASK[l][a] ? clampV(x) : 0));
  }
  return [vec, m];
}

export function breed(pa: Genome, pb: Genome, r: Rng): { child: Genome; fusions: Fusion[] } {
  const g = new Uint8Array(GENOME_B);
  const reg: Fusion[] = [];
  const read = (x: Genome, l: number, s: number) => [0, 1, 2, 3, 4].map(a => vecAt(x, l, s, a));
  for (let l = 0; l < NL; l++) {
    const sa = int(r, 2), sb = int(r, 2);
    const va = read(pa, l, sa), ma = form(pa, l, sa), ga = graft(pa, l, sa), da = depth(pa, l, sa);
    const vb = read(pb, l, sb), mb = form(pb, l, sb), gb = graft(pb, l, sb), db = depth(pb, l, sb);
    let tension = va.reduce((s, x, i) => s + Math.abs(x - vb[i]), 0) / NA;
    if (ma !== mb) tension += P.morph_tension;
    const p = Math.max(0, Math.min(1, (tension - P.fuse_t0) / (P.fuse_t1 - P.fuse_t0))) * P.fuse_pmax;
    const slots: [number[], number, number, number][] = [];
    if (unit(r) < p) {
      const fv = fuse(va, ma, vb, mb, l, r, reg);
      const newDepth = Math.min(127, Math.max(da, db) + 1);
      if (DOM[l][ma] >= DOM[l][mb]) { slots.push([va, ma, ga, da], [fv, mb, ma, newDepth]); }
      else { slots.push([vb, mb, gb, db], [fv, ma, mb, newDepth]); }
    } else {
      slots.push([va, ma, ga, da], [vb, mb, gb, db]);
    }
    for (let s = 0; s < 2; s++) {
      const [v0, m0, g0, d0] = slots[s];
      const [v1, m1] = mutate(v0, m0, l, r);
      writeAllele(g, l, s, m1, g0, d0, int(r, 65535), v1);
    }
  }
  return { child: g, fusions: reg };
}

export function founder(r: Rng): Genome {
  const g = new Uint8Array(GENOME_B);
  const bias = [0, 1, 2, 3, 4].map(() => normal(r, 1));
  const bs = bias.reduce((s, x) => s + Math.abs(x), 0) + 1e-9;
  for (let l = 0; l < NL; l++) for (let s = 0; s < 2; s++) {
    const mag = uniform(r, 14, 42);
    let d = bias.map(b => (b / bs) * 3 + normal(r, 0.9));
    const ds = d.reduce((t, x) => t + Math.abs(x), 0) + 1e-9;
    d = d.map((x, a) => (MASK[l][a] ? clampV((x / ds) * mag * NA) : 0));
    writeAllele(g, l, s, int(r, NM), NO_GRAFT, 0, int(r, 65535), d);
  }
  return g;
}
