// Combat between two stat blocks. Workshop issues #21, #23.

import { CB } from "./genome.ts";
import type { Stats } from "./express.ts";

const gate = (o: number, d: number, k: number) => Math.max(0, Math.min(1, (o - k * d) / (0.5 * o + 1)));
const strike = (a: Stats, d: Stats, gassed: boolean) => {
  let x = CB.aE * a.E * gate(a.E, d.S, CB.kE) + CB.aM * a.M * gate(a.M, d.T, CB.kM)
        + CB.aT * a.T * gate(a.T, d.M, CB.kT) + 1;
  x = Math.max(0.5, x - CB.flat_shell * d.S);
  return gassed ? x * 0.5 : x;
};
const riposte = (a: Stats, d: Stats) => CB.aR * d.E * gate(d.E, a.S, CB.kE);

export type FightState = { A: Stats; B: Stats; hpA: number; hpB: number; stA: number; stB: number;
  iA: number; iB: number; blockA: number; blockB: number; t: number; done: boolean };

export function fightStart(A: Stats, B: Stats): FightState {
  const lead = (A.R - B.R) / CB.lead_div;
  return { A, B, hpA: A.hp, hpB: B.hp, stA: A.stam, stB: B.stam, iA: 0, iB: 0,
    blockA: lead > 0 ? 0 : Math.min(-lead, CB.lead_cap),
    blockB: lead > 0 ? Math.min(lead, CB.lead_cap) : 0, t: 0, done: false };
}

// ONE tick. Realtime = call this on a clock; turn-based = call it when the
// UI advances; offline resolution = call it in a loop. Same rule, same result.
export function fightStep(f: FightState, maxTicks = 700): FightState {
  if (f.done) return f;
  const { A, B } = f;
  const gA = f.stA < A.cost, gB = f.stB < B.cost;
  if (f.blockA > 0) f.blockA -= 1; else f.iA += A.speed * (gA ? 0.5 : 1);
  if (f.blockB > 0) f.blockB -= 1; else f.iB += B.speed * (gB ? 0.5 : 1);
  f.stA = Math.min(A.stam, f.stA + A.regen);
  f.stB = Math.min(B.stam, f.stB + B.regen);
  if (f.iA >= 1) { f.iA -= 1; if (!gA) f.stA -= A.cost; f.hpB -= strike(A, B, gA); f.hpA -= riposte(A, B); }
  if (f.iB >= 1) { f.iB -= 1; if (!gB) f.stB -= B.cost; f.hpA -= strike(B, A, gB); f.hpB -= riposte(B, A); }
  f.t++;
  if (f.hpA <= 0 || f.hpB <= 0 || f.t >= maxTicks) f.done = true;
  return f;
}

export function fightResult(f: FightState): number {
  const fa = f.hpA / f.A.hp, fb = f.hpB / f.B.hp;
  if (Math.abs(fa - fb) < 1e-9) return 0;
  return fa > fb ? 1 : -1;
}

export function fight(A: Stats, B: Stats): FightState {
  const f = fightStart(A, B);
  while (!f.done) fightStep(f);
  return f;
}
