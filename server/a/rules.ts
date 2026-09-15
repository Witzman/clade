// Variant A's rules: the mirror deal, the round state machine, capture, the
// herd limit, the end and the draw rule, and replay from (seed, decisions).
// Workshop issues #54, #59; variant directions section 3.4 with the section
// 2.8 mirror deal; build plan 2026-09-15 piece A1.
//
// Pure. Imported by the tier 2 server room (server/a/room.ts, A3) and bundled
// into the browser (web/a/, A2). No IO, no clock, no engine randomness: every
// draw comes from a stream derived from the match seed, so a litter depends on
// (seed, round, side) only and cannot be rerolled by replaying a choice.
//
// Faked in tier 1, by design: founders are core's random founder() rather than
// the fourteen real animals, and the herd limit releases the oldest non-founder
// automatically (section 3.8, cut first item 2).

import { rng, founder, breed, fight, fightResult, express, stats } from "../../core/index.ts";
import type { Genome, Rng, Fusion, FightState } from "../../core/index.ts";

export const FOUNDERS = 5;
export const LITTER = 3;
export const HERD_LIMIT = 7;
export const ROUNDS = 7;
export const TO_WIN = 4;

export type Side = 0 | 1;
export type Pair = [number, number];

export type Creature = {
  id: number;           // match-unique; lower is older
  g: Genome;
  founder: boolean;
  born: number;         // round it was born in, 0 for founders
  from: Side;           // the side that bred it (a captured creature keeps it)
};

export type Young = { g: Genome; fusions: Fusion[] };

export type RoundRecord = {
  round: number;
  pairs: [Pair, Pair];
  fields: [number, number];
  fighters: [Genome, Genome];
  hpA: number; hpB: number; t: number;
  winner: Side | null;  // null: a drawn fight, scores for neither
};

export type Phase = "breed" | "field" | "over";

export type Result = { winner: Side | null; by: "wins" | "herd" | "draw"; wins: [number, number]; herds: [number, number] };

export type Match = {
  seed: number;
  round: number;                        // 1-based, the round being played
  phase: Phase;
  herds: [Creature[], Creature[]];
  wins: [number, number];
  pairs: [Pair, Pair] | null;           // this round's parents, once bred
  litters: [Young[], Young[]] | null;   // this round's young, public to both
  released: [Creature[], Creature[]];   // released by the herd limit before this round's breeding
  history: RoundRecord[];
  result: Result | null;
  nextId: number;
};

// What either player, and the computer, may read. Never a pending choice, never
// the seed.
export type PublicView = {
  round: number;
  phase: Phase;
  herds: [Genome[], Genome[]];
  wins: [number, number];
  litters: [Genome[], Genome[]] | null;
};

// One entry per round. `fields` is absent while the round waits for its fielding.
export type Decision = { pairs: [Pair, Pair]; fields?: [number, number] };

// ---------------------------------------------------------------- streams
export const STREAM = { deal: 1, litter: 2, computer: 3 } as const;

// A 32-bit seed for stream (kind, a, b) of `seed`. Integer mixing only.
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

// ---------------------------------------------------------------- setup
export function newMatch(seed: number): Match {
  const r = stream(seed, STREAM.deal, 0, 0);
  const deal: Genome[] = [];
  for (let i = 0; i < FOUNDERS; i++) deal.push(founder(r));
  let nextId = 0;
  const herds = ([0, 1] as Side[]).map(s =>
    deal.map(g => ({ id: nextId++, g: g.slice(), founder: true, born: 0, from: s }))) as [Creature[], Creature[]];
  return { seed: seed >>> 0, round: 1, phase: "breed", herds, wins: [0, 0], pairs: null, litters: null,
    released: [[], []], history: [], result: null, nextId };
}

export function view(m: Match): PublicView {
  return {
    round: m.round, phase: m.phase, wins: [m.wins[0], m.wins[1]],
    herds: [m.herds[0].map(c => c.g), m.herds[1].map(c => c.g)],
    litters: m.litters ? [m.litters[0].map(y => y.g), m.litters[1].map(y => y.g)] : null,
  };
}

// ---------------------------------------------------------------- validation
export function validPair(m: Match, side: Side, p: unknown): p is Pair {
  if (!Array.isArray(p) || p.length !== 2) return false;
  const [a, b] = p, n = m.herds[side].length;
  return Number.isInteger(a) && Number.isInteger(b) && a !== b && a >= 0 && b >= 0 && a < n && b < n;
}
export const validField = (f: unknown): f is number => Number.isInteger(f) && (f as number) >= 0 && (f as number) < LITTER;

// ---------------------------------------------------------------- the round
// Both players' parents at once. Throws on an illegal move: the caller (server
// or client) validates first with validPair.
export function applyBreed(m: Match, pairs: [Pair, Pair]): Match {
  if (m.phase !== "breed") throw new Error(`breed in phase ${m.phase}`);
  for (const s of [0, 1] as Side[]) if (!validPair(m, s, pairs[s])) throw new Error(`illegal pair for side ${s}`);
  const litters = ([0, 1] as Side[]).map(s => {
    const r = stream(m.seed, STREAM.litter, m.round, s);
    const [i, j] = pairs[s];
    const out: Young[] = [];
    for (let k = 0; k < LITTER; k++) {
      const { child, fusions } = breed(m.herds[s][i].g, m.herds[s][j].g, r);
      out.push({ g: child, fusions });
    }
    return out;
  }) as [Young[], Young[]];
  m.pairs = [[pairs[0][0], pairs[0][1]], [pairs[1][0], pairs[1][1]]];
  m.litters = litters;
  m.phase = "field";
  return m;
}

export function fightOf(a: Genome, b: Genome): FightState {
  return fight(stats(express(a)), stats(express(b)));
}

// Both players' fighters at once: fight, capture, release, round end.
export function applyField(m: Match, fields: [number, number]): Match {
  if (m.phase !== "field" || !m.litters || !m.pairs) throw new Error(`field in phase ${m.phase}`);
  if (!validField(fields[0]) || !validField(fields[1])) throw new Error("illegal field");
  const fighters: [Genome, Genome] = [m.litters[0][fields[0]].g, m.litters[1][fields[1]].g];
  const f = fightOf(fighters[0], fighters[1]);
  const res = fightResult(f);
  const winner: Side | null = res === 0 ? null : res > 0 ? 0 : 1;
  const mk = (g: Genome, from: Side): Creature => ({ id: m.nextId++, g, founder: false, born: m.round, from });
  const a = mk(fighters[0], 0), b = mk(fighters[1], 1);
  if (winner === null) {
    m.herds[0].push(a); m.herds[1].push(b);
  } else {
    // The winning fighter stays in its own herd; the losing fighter joins it.
    m.herds[winner].push(winner === 0 ? a : b);
    m.herds[winner].push(winner === 0 ? b : a);
    m.wins[winner]++;
  }
  m.history.push({ round: m.round, pairs: m.pairs, fields: [fields[0], fields[1]], fighters,
    hpA: f.hpA, hpB: f.hpB, t: f.t, winner });
  m.pairs = null;
  m.litters = null;
  if (Math.max(m.wins[0], m.wins[1]) >= TO_WIN || m.round >= ROUNDS) {
    m.phase = "over";
    m.result = decide(m);
    m.released = [[], []];
    return m;
  }
  m.round++;
  m.phase = "breed";
  m.released = [release(m.herds[0]), release(m.herds[1])];
  return m;
}

// Above the limit, the oldest non-founder goes first. Founders are never
// released, so a herd never drops below FOUNDERS.
export function release(herd: Creature[]): Creature[] {
  const out: Creature[] = [];
  while (herd.length > HERD_LIMIT) {
    let k = -1;
    for (let i = 0; i < herd.length; i++) if (!herd[i].founder && (k < 0 || herd[i].id < herd[k].id)) k = i;
    if (k < 0) break;
    out.push(herd.splice(k, 1)[0]);
  }
  return out;
}

// First to four; after seven rounds most round wins; then the larger herd (as
// it stands at the end, before any release); then a draw.
export function decide(m: Match): Result {
  const wins: [number, number] = [m.wins[0], m.wins[1]];
  const herds: [number, number] = [m.herds[0].length, m.herds[1].length];
  if (wins[0] !== wins[1]) return { winner: wins[0] > wins[1] ? 0 : 1, by: "wins", wins, herds };
  if (herds[0] !== herds[1]) return { winner: herds[0] > herds[1] ? 0 : 1, by: "herd", wins, herds };
  return { winner: null, by: "draw", wins, herds };
}

// ---------------------------------------------------------------- replay
export const MAX_DECISIONS = ROUNDS;

// Validates an untrusted log's shape and replays it. Null when any entry is
// malformed or illegal at the point it is applied. Only the last entry may lack
// `fields` (a round waiting for its fielding).
export function replay(seed: number, decisions: unknown): Match | null {
  if (!Array.isArray(decisions) || decisions.length > MAX_DECISIONS) return null;
  const m = newMatch(seed);
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i] as Decision;
    if (m.phase !== "breed" || !d || typeof d !== "object" || !Array.isArray(d.pairs) || d.pairs.length !== 2) return null;
    if (!validPair(m, 0, d.pairs[0]) || !validPair(m, 1, d.pairs[1])) return null;
    applyBreed(m, d.pairs);
    if (d.fields === undefined) { if (i !== decisions.length - 1) return null; break; }
    if (!Array.isArray(d.fields) || d.fields.length !== 2 || !validField(d.fields[0]) || !validField(d.fields[1])) return null;
    applyField(m, d.fields);
  }
  return m;
}

// The log that reproduces a match, for localStorage and for the server.
export function decisions(m: Match): Decision[] {
  const out: Decision[] = m.history.map(h => ({ pairs: h.pairs, fields: h.fields }));
  if (m.phase === "field" && m.pairs) out.push({ pairs: m.pairs });
  return out;
}

// FNV-1a over everything a player can see, as 8 hex digits: herds (genomes and
// ages), wins, round, phase, litters and fight results. Detects drift, not
// tampering.
export function hash(m: Match): string {
  let h = 0x811c9dc5;
  const byte = (b: number) => { h = Math.imul(h ^ (b & 255), 0x01000193); };
  const u32 = (x: number) => { for (let i = 0; i < 4; i++) byte(x >>> (i * 8)); };
  const f64 = new Float64Array(1), f64b = new Uint8Array(f64.buffer);
  const num = (x: number) => { f64[0] = x; for (let i = 0; i < 8; i++) byte(f64b[i]); };
  const gen = (g: Genome) => { for (let i = 0; i < g.length; i++) byte(g[i]); };
  u32(m.round); byte(m.phase === "breed" ? 0 : m.phase === "field" ? 1 : 2); u32(m.wins[0]); u32(m.wins[1]);
  for (const herd of m.herds) { u32(herd.length); for (const c of herd) { u32(c.id); byte(c.founder ? 1 : 0); gen(c.g); } }
  if (m.litters) for (const l of m.litters) for (const y of l) gen(y.g);
  for (const r of m.history) { num(r.hpA); num(r.hpB); u32(r.t); byte(r.winner === null ? 2 : r.winner); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
