// A fight as a list of readable actions, for the replay. Workshop issue #60
// (build plan piece X2); variant directions §1.4, §2.10.
//
// core/fight.ts resolves a fight tick by tick and exposes only hit points. The
// replay has to say WHY a blow landed or did not ("sharp — through", "heavy —
// missed, too quick"), so each strike is split into the channels of core's
// private `strike`: sharp against armour, heavy against quick, quick against
// heavy, armour's flat softening, and the defender's sharp parts cutting back.
//
// The fight itself is still stepped by core's own `fightStep`; nothing here
// decides an outcome. What is copied outside core/ is (1) the channel split of
// `strike` and `riposte`, in the same floating-point operation order, and
// (2) the "who acts this tick" test. tests/fight-events.test.ts folds the event
// damages alone and requires the result to equal `core.fight()` bit for bit
// over 9000 random fights, so a change to core/fight.ts that this copy misses
// fails CI rather than showing a replay that disagrees with the result.
//
// No gassed flag (§2.10): the state is reached in about one fight in fifty and
// would read as a bug. When it applies it is inside `damage`, and nowhere else.

import { CB } from "../core/genome.ts";
import { fightResult, fightStart, fightStep } from "../core/fight.ts";
import type { Stats } from "../core/express.ts";

export type Side = "A" | "B";
export type Channel = "sharp" | "heavy" | "quick";
/** How much of a channel's power its counter let through. */
export type Outcome = "through" | "partly" | "stopped";

export type ChannelHit = {
  channel: Channel;
  /** The attacker's potential in this channel, before the counter. */
  power: number;
  /** 0..1, the share the counter let through. */
  gate: number;
  outcome: Outcome;
};

export type LeadEvent = { kind: "lead"; side: Side; ticks: number };
export type StrikeEvent = {
  kind: "strike";
  tick: number;
  side: Side;
  /** Channels the attacker has any power in, strongest first. */
  channels: ChannelHit[];
  /** Hit points armour's flat softening took off this blow. */
  softened: number;
  /** Hit points the defender lost. Exactly what core subtracted. */
  damage: number;
  /** Hit points the attacker lost to the defender's sharp parts. Exactly what core subtracted. */
  riposte: number;
  /** Both sides' hit points after this action. */
  hpA: number;
  hpB: number;
};
export type EndEvent = { kind: "end"; tick: number; winner: Side | null; timeout: boolean; hpA: number; hpB: number };
export type FightEvent = LeadEvent | StrikeEvent | EndEvent;

export type FightRecord = {
  A: Stats;
  B: Stats;
  events: FightEvent[];
  /** Final state, as core's fightStep left it. */
  hpA: number;
  hpB: number;
  t: number;
  /** core's fightResult: 1 A wins, -1 B wins, 0 draw. */
  result: number;
};

// core/fight.ts `gate`, unchanged.
const gate = (o: number, d: number, k: number) => Math.max(0, Math.min(1, (o - k * d) / (0.5 * o + 1)));

const outcome = (g: number): Outcome => (g >= 0.6 ? "through" : g <= 0.05 ? "stopped" : "partly");

/** One strike by `a` on `d`, split into channels. `damage` and `riposte` follow
 *  core/fight.ts `strike` and `riposte` operation for operation. */
function strike(a: Stats, d: Stats, gassed: boolean) {
  const gE = gate(a.E, d.S, CB.kE), gM = gate(a.M, d.T, CB.kM), gT = gate(a.T, d.M, CB.kT);
  const pE = CB.aE * a.E, pM = CB.aM * a.M, pT = CB.aT * a.T;
  // Same expression shape as core: ((aE*E*gE + aM*M*gM) + aT*T*gT) + 1.
  const raw = CB.aE * a.E * gE + CB.aM * a.M * gM + CB.aT * a.T * gT + 1;
  const soft = Math.max(0.5, raw - CB.flat_shell * d.S);
  const damage = gassed ? soft * 0.5 : soft;
  const riposte = CB.aR * d.E * gate(d.E, a.S, CB.kE);
  const channels: ChannelHit[] = [];
  if (pE > 0) channels.push({ channel: "sharp", power: pE, gate: gE, outcome: outcome(gE) });
  if (pM > 0) channels.push({ channel: "heavy", power: pM, gate: gM, outcome: outcome(gM) });
  if (pT > 0) channels.push({ channel: "quick", power: pT, gate: gT, outcome: outcome(gT) });
  channels.sort((x, y) => y.power - x.power);
  return { channels, softened: raw - soft, damage, riposte };
}

/** Resolve a fight with core's rule and record every action. */
export function fightEvents(A: Stats, B: Stats, maxTicks = 700): FightRecord {
  const f = fightStart(A, B);
  const events: FightEvent[] = [];
  if (f.blockB > 0) events.push({ kind: "lead", side: "A", ticks: Math.ceil(f.blockB) });
  else if (f.blockA > 0) events.push({ kind: "lead", side: "B", ticks: Math.ceil(f.blockA) });
  // Hit points as the events alone give them, so every event carries a
  // consistent snapshot for the bars.
  let hpA = A.hp, hpB = B.hp;
  while (!f.done) {
    // Pre-step state: exactly the tests fightStep makes before it mutates.
    const gA = f.stA < A.cost, gB = f.stB < B.cost;
    const actsA = !(f.blockA > 0) && f.iA + A.speed * (gA ? 0.5 : 1) >= 1;
    const actsB = !(f.blockB > 0) && f.iB + B.speed * (gB ? 0.5 : 1) >= 1;
    const tick = f.t;
    if (actsA) {
      const s = strike(A, B, gA);
      hpB -= s.damage; hpA -= s.riposte;
      events.push({ kind: "strike", tick, side: "A", ...s, hpA, hpB });
    }
    if (actsB) {
      const s = strike(B, A, gB);
      hpA -= s.damage; hpB -= s.riposte;
      events.push({ kind: "strike", tick, side: "B", ...s, hpA, hpB });
    }
    fightStep(f, maxTicks);
  }
  const result = fightResult(f);
  events.push({
    kind: "end", tick: f.t, winner: result > 0 ? "A" : result < 0 ? "B" : null,
    timeout: f.hpA > 0 && f.hpB > 0, hpA: f.hpA, hpB: f.hpB,
  });
  return { A, B, events, hpA: f.hpA, hpB: f.hpB, t: f.t, result };
}

// ---------------------------------------------------------------- wording
// The counters panel (§1.4) says: armour stops sharp weapons and softens every
// blow; a heavy animal cannot land a blow on a quick one; quick, light attacks
// do not trouble a heavy animal; sharp parts cut whoever attacks them; the
// longer reach strikes first. The replay lines use the same words.

const WORDS: Record<Channel, Record<Outcome, string>> = {
  sharp: { through: "sharp — through", partly: "sharp — blunted by armour", stopped: "sharp — stopped by armour" },
  heavy: { through: "heavy — lands", partly: "heavy — glances, too quick", stopped: "heavy — missed, too quick" },
  quick: { through: "quick — through", partly: "quick — barely troubles it", stopped: "quick — shrugged off, too heavy" },
};

/** A channel is named when it is at least this share of the attacker's strongest. */
const NAMED_SHARE = 0.25;

/** Short phrases for one event, strongest channel first. Never empty. */
export function describe(e: FightEvent, names: Record<Side, string> = { A: "A", B: "B" }): string[] {
  if (e.kind === "lead") return [`${names[e.side]}: longer reach — strikes first`];
  if (e.kind === "end") {
    if (e.winner === null) return ["a draw"];
    return [e.timeout ? `${names[e.winner]} wins on time` : `${names[e.winner]} wins`];
  }
  const top = e.channels.length ? e.channels[0].power : 0;
  const out = e.channels.filter(c => c.power >= top * NAMED_SHARE).map(c => WORDS[c.channel][c.outcome]);
  if (!out.length) out.push("a light blow");
  const raw = e.softened + e.damage;
  if (e.softened > 0 && e.softened >= 0.2 * raw) out.push("armour softens it");
  if (e.riposte >= 0.5) out.push("sharp parts cut back");
  return out;
}
