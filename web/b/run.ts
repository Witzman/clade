// Variant B's run engine: one expedition from (seed, decisions), with the
// computer expedition on the same seed alongside it. Workshop issues #55, #63;
// variant directions section 5.4 with the section 2.7 amendments; build plan
// 2026-09-15 piece B1.
//
// Pure: no IO, no DOM, no clock, no engine randomness. Every draw comes from a
// stream of the run seed, so founders, the route, litters, rival herds and
// rival orders are fixed by the seed and the step, and replaying a log
// reproduces the state exactly (no reroll).
//
// The stop, as built:
//   breed      choose two; three young are born from stream (seed, stop, side)
//   keep       keep one of the three (section 2.7 amendment c)
//   release    above eight, release down to eight
//   lineup     the opponent's three are shown; bring up to three that fit the
//              limit (all that fit, if fewer than three)
//   answer     the opponent sends one creature at a time, in an order drawn
//              when the lineup opens from (seed, stop, your herd); you answer
//              each with one you brought (section 2.7 amendment b). The client
//              reveals only order[step]. Losers join the other side; a rival
//              herd is left behind, so a creature lost to it is gone
//   end        below two creatures the expedition ends
// At stops 3, 6 and 9 the opponent is the computer expedition: it picks its
// three and sends them the same way, and creatures change sides between runs.
// Empty slots: a creature facing an empty slot wins, an empty slot facing a
// creature loses, and nothing changes sides for either.
//
// End (section 5.4): after stop 9, or when either expedition ends. The one that
// went further wins; if level, the larger herd; then more crossing fights won.
//
// Faked in tier 1, by design: founders are core's random founder(), not the
// fourteen real animals; the seed is chosen by the client; the other
// expedition is always the computer.

import { founder, breed, int, fight, fightResult } from "../../core/index.ts";
import type { Genome, Fusion } from "../../core/index.ts";
import {
  DEAL, CHOOSE, STOPS, LITTER, HERD_CAP, LINEUP, MIN_HERD, SHOWN_AHEAD, LIMITS, STREAM,
  stream, streamSeed, herdKey, fits, tierOf, isCrossing, statsOf,
} from "./base.ts";
import type { Limit } from "./base.ts";
import { rivalAt } from "./rivals.ts";
import {
  chooseFounders, choosePair, chooseKeep, chooseRelease, chooseThree, chooseAnswer, predictedThree,
  bankedWins, DEFAULT_POLICY,
} from "./computer.ts";
import type { Policy, Context } from "./computer.ts";

export type Side = 0 | 1;              // 0 the player, 1 the computer expedition
export const PLAYER: Side = 0, COMPUTER: Side = 1;

export type Creature = {
  id: number;                          // run-unique; lower is older
  g: Genome;
  origin: "founder" | "young" | "captured" | "rival";
  born: number;                        // stop it was born or met at, 0 for founders
};

export type Young = { g: Genome; fusions: Fusion[] };

export type Phase = "founders" | "breed" | "keep" | "release" | "lineup" | "answer" | "over";

export type FightRecord = {
  mine: number; theirs: number;        // creature ids
  hpA: number; hpB: number; t: number;
  result: 1 | -1 | 0;                  // from the answering side's view
};

export type StopRecord = {
  stop: number; limit: Limit; crossing: boolean;
  opponent: Creature[]; order: number[]; lineup: number[];
  fights: FightRecord[]; wins: number;
};

export type Expedition = {
  herd: Creature[];
  seen: Genome[];                      // rival creatures met, the breeding reference
  alive: boolean;
  end: number;                         // the stop it fell at; STOPS + 1 when it finished
  fightsWon: number;
  crossingWins: number;
  stops: StopRecord[];                 // regular stops and crossings it answered
  pairs: [number, number][];           // creature ids bred, per stop
};

export type Result = {
  winner: Side | null;
  by: "further" | "herd" | "crossings" | "draw";
  ends: [number, number]; herds: [number, number]; crossingWins: [number, number];
};

export type RunOptions = {
  policy: Policy;                      // the computer expedition's
  selection: boolean;                  // rival generator: true is the #21 selection run
  playOn: boolean;                     // measurement only: the player continues after the computer ends
};
export const DEFAULT_OPTIONS: RunOptions = { policy: DEFAULT_POLICY, selection: true, playOn: false };

export type Decision =
  | { t: "founders"; pick: number[] }  // three indices into the deal
  | { t: "breed"; ids: [number, number] }
  | { t: "keep"; i: number }           // litter index
  | { t: "release"; ids: number[] }    // exactly herd - 8 creature ids
  | { t: "lineup"; ids: number[] }     // min(3, fitting) creature ids
  | { t: "answer"; slot: number };     // lineup index answering order[step]

export type Run = {
  seed: number;
  opts: RunOptions;
  route: Limit[];
  deal: Genome[];
  phase: Phase;
  stop: number;                        // 1..9; 0 before the founders are chosen
  exps: [Expedition, Expedition];
  litter: Young[] | null;              // the player's, while keeping
  opponent: Creature[] | null;         // the player's opponent at this stop
  order: number[] | null;              // opponent indices in the order they step up
  lineup: number[] | null;             // creature ids the player brought
  step: number;                        // index into order
  mineLeft: number; theirsLeft: number; wins: number;
  fights: FightRecord[];
  result: Result | null;
  log: Decision[];
  nextId: number;
};

// ---------------------------------------------------------------- setup
export function newRun(seed: number, opts: RunOptions = DEFAULT_OPTIONS): Run {
  seed >>>= 0;
  const rr = stream(seed, STREAM.route, 0, 0);
  const route = Array.from({ length: STOPS }, () => LIMITS[int(rr, LIMITS.length)]);
  const rd = stream(seed, STREAM.deal, 0, 0);
  const deal = Array.from({ length: DEAL }, () => founder(rd));
  const exp = (): Expedition => ({ herd: [], seen: [], alive: true, end: STOPS + 1, fightsWon: 0, crossingWins: 0, stops: [], pairs: [] });
  const run: Run = {
    seed, opts, route, deal, phase: "founders", stop: 0, exps: [exp(), exp()], litter: null, opponent: null,
    order: null, lineup: null, step: 0, mineLeft: 0, theirsLeft: 0, wins: 0, fights: [], result: null, log: [], nextId: 0,
  };
  run.exps[COMPUTER].herd = chooseFounders(deal).map(i => mk(run, deal[i].slice(), "founder", 0));
  return run;
}

const mk = (run: Run, g: Genome, origin: Creature["origin"], born: number): Creature =>
  ({ id: run.nextId++, g, origin, born });

// ---------------------------------------------------------------- reading
export const limit = (run: Run): Limit => run.route[Math.max(run.stop, 1) - 1];
// The limits of this stop and the next two (the route strip).
export const upcoming = (run: Run): Limit[] => run.route.slice(Math.max(run.stop, 1) - 1, Math.max(run.stop, 1) - 1 + SHOWN_AHEAD);
export const eligible = (run: Run, side: Side = PLAYER): Creature[] =>
  run.exps[side].herd.filter(c => fits(limit(run), tierOf(c.g)));
// The opponent creature stepping up now, during "answer".
export const stepping = (run: Run): Creature | null =>
  run.phase === "answer" && run.opponent && run.order ? run.opponent[run.order[run.step]] : null;
const byId = (herd: Creature[], id: number) => herd.findIndex(c => c.id === id);
const ctx = (run: Run, side: Side, herd = run.exps[side].herd.map(c => c.g)): Context =>
  ({ herd, seen: run.exps[side].seen, route: run.route, stop: run.stop });

// ---------------------------------------------------------------- validation
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) < hi;
const distinct = (xs: unknown[]) => new Set(xs).size === xs.length;

// Null when the decision is legal now, otherwise the reason.
export function illegal(run: Run, d: unknown): string | null {
  if (!d || typeof d !== "object") return "not a decision";
  const x = d as Record<string, unknown>;
  const herd = run.exps[PLAYER].herd;
  const ids = (v: unknown, n: number) => Array.isArray(v) && v.length === n && distinct(v) && v.every(id => byId(herd, id as number) >= 0);
  if (x.t !== run.phase) return `expected ${run.phase}, got ${String(x.t)}`;
  switch (run.phase) {
    case "founders":
      return Array.isArray(x.pick) && x.pick.length === CHOOSE && distinct(x.pick) && x.pick.every(i => isInt(i, 0, DEAL)) ? null : "bad founders";
    case "breed":
      return ids(x.ids, 2) ? null : "bad pair";
    case "keep":
      return isInt(x.i, 0, LITTER) ? null : "bad keep";
    case "release":
      return ids(x.ids, herd.length - HERD_CAP) ? null : "bad release";
    case "lineup": {
      const fit = eligible(run).map(c => c.id);
      return ids(x.ids, Math.min(LINEUP, fit.length)) && (x.ids as number[]).every(id => fit.includes(id)) ? null : "bad lineup";
    }
    case "answer":
      return isInt(x.slot, 0, run.lineup!.length) && (run.mineLeft & (1 << (x.slot as number))) ? null : "bad answer";
    default:
      return "run is over";
  }
}

// ---------------------------------------------------------------- the stop
// Applies a legal decision. Throws on an illegal one: validate with illegal().
export function apply(run: Run, d: Decision): Run {
  const why = illegal(run, d);
  if (why) throw new Error(why);
  run.log.push(JSON.parse(JSON.stringify(d)) as Decision);
  const me = run.exps[PLAYER];
  switch (d.t) {
    case "founders":
      me.herd = d.pick.map(i => mk(run, run.deal[i].slice(), "founder", 0));
      run.stop = 1;
      openStop(run);
      break;
    case "breed": {
      const [a, b] = d.ids.map(id => me.herd[byId(me.herd, id)].g);
      const r = stream(run.seed, STREAM.litter, run.stop, PLAYER);
      run.litter = Array.from({ length: LITTER }, () => { const { child, fusions } = breed(a, b, r); return { g: child, fusions }; });
      me.pairs.push([d.ids[0], d.ids[1]]);
      run.phase = "keep";
      break;
    }
    case "keep":
      me.herd.push(mk(run, run.litter![d.i].g, "young", run.stop));
      run.litter = null;
      if (me.herd.length > HERD_CAP) run.phase = "release";
      else openLineup(run);
      break;
    case "release":
      me.herd = me.herd.filter(c => !d.ids.includes(c.id));
      openLineup(run);
      break;
    case "lineup":
      startLineup(run, d.ids);
      break;
    case "answer": {
      const rv = run.order![run.step];
      const f = settle(run, PLAYER, run.lineup![d.slot], run.opponent![rv], isCrossing(run.stop));
      run.fights.push(f);
      if (f.result > 0) run.wins++;
      run.mineLeft &= ~(1 << d.slot);
      run.theirsLeft &= ~(1 << rv);
      run.step++;
      advance(run);
      break;
    }
  }
  return run;
}

function startLineup(run: Run, ids: number[]) {
  run.lineup = ids.slice();
  run.mineLeft = (1 << ids.length) - 1;
  run.theirsLeft = (1 << run.opponent!.length) - 1;
  run.wins = bankedWins(ids.length, run.opponent!.length);
  run.exps[PLAYER].fightsWon += run.wins;
  run.step = 0;
  run.fights = [];
  advance(run);
}

// A stop opens: the computer expedition breeds (it never waits on the
// player), then the player breeds.
function openStop(run: Run) {
  const cpu = run.exps[COMPUTER];
  if (cpu.alive) {
    const c = ctx(run, COMPUTER);
    const [i, j] = choosePair(c, stream(run.seed, STREAM.cpuSample, run.stop, 0), run.opts.policy);
    cpu.pairs.push([cpu.herd[i].id, cpu.herd[j].id]);
    const r = stream(run.seed, STREAM.litter, run.stop, COMPUTER);
    const litter = Array.from({ length: LITTER }, () => breed(cpu.herd[i].g, cpu.herd[j].g, r).child);
    cpu.herd.push(mk(run, litter[chooseKeep(litter, c)], "young", run.stop));
    const gone = chooseRelease(ctx(run, COMPUTER));
    cpu.herd = cpu.herd.filter((_, k) => !gone.includes(k));
  }
  run.phase = "breed";
}

// The lineup opens: the opponent and its order are fixed now, from the seed,
// the stop and the player's herd as it stands.
function openLineup(run: Run) {
  const crossing = isCrossing(run.stop), cpu = run.exps[COMPUTER];
  run.lineup = null; run.fights = []; run.wins = 0; run.step = 0;
  if (crossing && !cpu.alive) { run.opponent = null; run.order = null; endStop(run); return; }
  if (crossing) {
    const mine = eligible(run, COMPUTER), yours = eligible(run, PLAYER);
    const three = chooseThree(mine.map(c => c.g), predictedThree(yours.map(c => c.g), mine.map(c => c.g)),
      run.opts.policy, stream(run.seed, STREAM.cpuChoice, run.stop, 99));
    run.opponent = three.map(i => mine[i]);
  } else {
    run.opponent = rivalAt(run.seed, run.stop, limit(run), run.opts.selection).map(g => mk(run, g, "rival", run.stop));
  }
  run.order = order(run.seed, run.stop, PLAYER, run.exps[PLAYER].herd, run.opponent.length);
  run.phase = "lineup";
  if (eligible(run).length === 0) startLineup(run, []);
}

export function order(seed: number, stop: number, side: Side, herd: Creature[], n: number): number[] {
  const r = stream(seed, STREAM.order, stop * 2 + side, herdKey(herd.map(c => c.g)));
  const o = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = int(r, i + 1); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}

// Steps past what needs no decision; stops at the next answer or ends the stop.
function advance(run: Run) {
  if (run.step < run.order!.length && run.mineLeft) { run.phase = "answer"; return; }
  const me = run.exps[PLAYER], crossing = isCrossing(run.stop);
  me.stops.push({ stop: run.stop, limit: limit(run), crossing, opponent: run.opponent!, order: run.order!,
    lineup: run.lineup!, fights: run.fights, wins: run.wins });
  if (!crossing) { me.seen.push(...run.opponent!.map(c => c.g)); computerStop(run); }
  endStop(run);
}

// One fight between an answering creature and the one stepping up; captures.
function settle(run: Run, side: Side, mineId: number, theirs: Creature, crossing: boolean): FightRecord {
  const X = run.exps[side], Y = run.exps[1 - side];
  const a = X.herd[byId(X.herd, mineId)];
  const f = fight(statsOf(a.g), statsOf(theirs.g));
  const result = fightResult(f) as 1 | -1 | 0;
  if (result > 0) {
    X.fightsWon++;
    if (crossing) { Y.herd.splice(byId(Y.herd, theirs.id), 1); X.crossingWins++; }
    X.herd.push(crossing ? { ...theirs, origin: "captured" } : { ...theirs, g: theirs.g.slice(), origin: "captured" });
  } else if (result < 0) {
    X.herd.splice(byId(X.herd, a.id), 1);
    if (crossing) { Y.herd.push({ ...a, origin: "captured" }); Y.fightsWon++; Y.crossingWins++; }
  }
  return { mine: a.id, theirs: theirs.id, hpA: f.hpA, hpB: f.hpB, t: f.t, result };
}

// The computer expedition's own regular stop against the same rival herd.
function computerStop(run: Run) {
  const cpu = run.exps[COMPUTER];
  if (!cpu.alive) return;
  const p = run.opts.policy, lim = limit(run);
  const rival = rivalAt(run.seed, run.stop, lim, run.opts.selection).map(g => mk(run, g, "rival", run.stop));
  const fit = cpu.herd.filter(c => fits(lim, tierOf(c.g)));
  const lineup = chooseThree(fit.map(c => c.g), rival.map(c => c.g), p, stream(run.seed, STREAM.cpuChoice, run.stop, 0)).map(i => fit[i]);
  const ord = order(run.seed, run.stop, COMPUTER, cpu.herd, rival.length);
  let mine = (1 << lineup.length) - 1, theirs = (1 << rival.length) - 1;
  let wins = bankedWins(lineup.length, rival.length);
  cpu.fightsWon += wins;
  const fights: FightRecord[] = [];
  for (let s = 0; s < ord.length && mine; s++) {
    const rv = ord[s];
    const slot = chooseAnswer(lineup.map(c => c.g), rival.map(c => c.g), mine, theirs, wins, rv, p,
      stream(run.seed, STREAM.cpuChoice, run.stop, 1 + s));
    const f = settle(run, COMPUTER, lineup[slot].id, rival[rv], false);
    fights.push(f);
    if (f.result > 0) wins++;
    mine &= ~(1 << slot); theirs &= ~(1 << rv);
  }
  cpu.stops.push({ stop: run.stop, limit: lim, crossing: false, opponent: rival, order: ord,
    lineup: lineup.map(c => c.id), fights, wins });
  cpu.seen.push(...rival.map(c => c.g));
}

function endStop(run: Run) {
  for (const X of run.exps) if (X.alive && X.herd.length < MIN_HERD) { X.alive = false; X.end = run.stop; }
  const me = run.exps[PLAYER], cpu = run.exps[COMPUTER];
  run.litter = null;
  if (run.stop >= STOPS || !me.alive || (!cpu.alive && !run.opts.playOn)) {
    run.phase = "over";
    run.opponent = null; run.order = null; run.lineup = null;
    run.result = decide(run);
    return;
  }
  run.stop++;
  openStop(run);
}

export function decide(run: Run): Result {
  const [P, C] = run.exps;
  const ends: [number, number] = [P.end, C.end];
  const herds: [number, number] = [P.herd.length, C.herd.length];
  const crossingWins: [number, number] = [P.crossingWins, C.crossingWins];
  const cmp = (a: number, b: number) => (a === b ? null : a > b ? PLAYER : COMPUTER);
  let w = cmp(ends[0], ends[1]);
  if (w !== null) return { winner: w, by: "further", ends, herds, crossingWins };
  if ((w = cmp(herds[0], herds[1])) !== null) return { winner: w, by: "herd", ends, herds, crossingWins };
  if ((w = cmp(crossingWins[0], crossingWins[1])) !== null) return { winner: w, by: "crossings", ends, herds, crossingWins };
  return { winner: null, by: "draw", ends, herds, crossingWins };
}

// ---------------------------------------------------------------- replay
// founders + 9 stops x (pair, keep, release, lineup, three answers).
export const MAX_DECISIONS = 1 + STOPS * 7;

// Validates an untrusted log and replays it. Null when any entry is malformed
// or illegal at the point it is applied. A lineup that fits no creature is
// applied by the engine itself and is not in the log.
export function replay(seed: number, log: unknown, opts: RunOptions = DEFAULT_OPTIONS): Run | null {
  if (!Array.isArray(log) || log.length > MAX_DECISIONS) return null;
  const run = newRun(seed, opts);
  for (const d of log) {
    if (illegal(run, d)) return null;
    apply(run, d as Decision);
  }
  return run;
}

// FNV-1a over everything a player can see or that decides what comes next.
// Detects drift, not tampering.
export function hash(run: Run): string {
  let h = 0x811c9dc5;
  const byte = (b: number) => { h = Math.imul(h ^ (b & 255), 0x01000193); };
  const u32 = (x: number) => { for (let i = 0; i < 4; i++) byte(x >>> (i * 8)); };
  const f64 = new Float64Array(1), f64b = new Uint8Array(f64.buffer);
  const num = (x: number) => { f64[0] = x; for (let i = 0; i < 8; i++) byte(f64b[i]); };
  const gen = (g: Genome) => { for (let i = 0; i < g.length; i++) byte(g[i]); };
  const creatures = (cs: Creature[]) => { u32(cs.length); for (const c of cs) { u32(c.id); gen(c.g); byte(c.origin.length); u32(c.born); } };
  u32(run.stop); byte(Phase_CODE[run.phase]); u32(run.step); u32(run.mineLeft); u32(run.theirsLeft); u32(run.wins);
  for (const X of run.exps) {
    creatures(X.herd); byte(X.alive ? 1 : 0); u32(X.end); u32(X.fightsWon); u32(X.crossingWins); u32(X.seen.length);
    for (const s of X.stops) { u32(s.stop); for (const f of s.fights) { u32(f.mine); u32(f.theirs); num(f.hpA); num(f.hpB); u32(f.t); } }
  }
  if (run.litter) for (const y of run.litter) gen(y.g);
  if (run.opponent) creatures(run.opponent);
  if (run.order) for (const i of run.order) byte(i);
  if (run.lineup) for (const id of run.lineup) u32(id);
  return (h >>> 0).toString(16).padStart(8, "0");
}
const Phase_CODE: Record<Phase, number> = { founders: 0, breed: 1, keep: 2, release: 3, lineup: 4, answer: 5, over: 6 };

// Re-exported so a client needs one import.
export { STOPS, HERD_CAP, LINEUP, LITTER, CHOOSE, DEAL, isCrossing, fits, tierOf, streamSeed };
export type { Limit, Policy };
