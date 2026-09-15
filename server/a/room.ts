// Variant A's server room: two people, one match. Workshop issues #54, #64;
// variant directions section 3.4; build plan 2026-09-15 piece A3.
//
// A Handler over server/a/rules.ts. The server owns sockets, the clock and the
// grace period; this file owns what they mean for A:
//
//   - Breeding is simultaneous and hidden: each side's pair stays on the server
//     until both are in or the breed clock (45 s) runs out. Then both pairs and
//     all six young are revealed to both players.
//   - Fielding is the same, with the field clock (20 s). The frame that carries
//     the fight is the first frame in which either side's fielded young appears.
//   - A side that has not committed when the clock runs out times out, and gets
//     a random pick drawn from the match's own seed.
//   - A dropped seat is not special: the clock keeps running and the seat times
//     out. A seat that is empty for good (an explicit leave, or a grace period
//     that expired) times out at once, so the player still there does not sit
//     out the clock. Three consecutive timeouts forfeit the match.
//
// The match seed is the room's own, drawn here and never sent before the
// result. Every litter is a pure function of (seed, round, side), so a client
// holding the seed could preview its young for every pair before choosing;
// Room.seed is sent in `matched` and is therefore not used. The result carries
// the seed and the decision log, so a client can verify the match by replay.
//
// A's computer opponent stays in the browser (build plan section 0), so this
// handler declares no computer seat and no entry: players queue directly.

import { randomInt } from "node:crypto";
import { int } from "../../core/index.ts";
import type { Genome } from "../../core/index.ts";
import type { Handler, Outbound, Room, Side } from "../types.ts";
import { newMatch, applyBreed, applyField, validPair, validField, stream, decisions, hash,
         LITTER, ROUNDS, TO_WIN, HERD_LIMIT } from "./rules.ts";
import type { Creature, Match, Pair, RoundRecord } from "./rules.ts";

export const BREED_MS = 45000;
export const FIELD_MS = 20000;
export const FORFEIT_AFTER = 3;

// rules.ts STREAM uses kinds 1-3.
const STREAM_TIMEOUT = 4;

type State = {
  m: Match;
  seed: number;
  pairs: [Pair | null, Pair | null];        // this round's hidden breed commits
  fields: [number | null, number | null];   // this round's hidden field commits
  timeouts: [number, number];               // consecutive, per side
  vacant: [boolean, boolean];               // the seat is empty for good
  done: boolean;
};

export type ARoomOptions = { breedMs?: number; fieldMs?: number; seed?: () => number };

const other = (s: Side): Side => (s === 0 ? 1 : 0);
const st = (room: Room) => room.state as State;

export function toHex(g: Genome): string {
  let s = "";
  for (let i = 0; i < g.length; i++) s += g[i].toString(16).padStart(2, "0");
  return s;
}

const creature = (c: Creature) => ({ id: c.id, g: toHex(c.g), founder: c.founder, born: c.born, from: c.from });
const herdsOf = (m: Match) => m.herds.map(h => h.map(creature));
const littersOf = (m: Match) => m.litters!.map(l => l.map(y => ({ g: toHex(y.g), fusions: y.fusions })));
const record = (r: RoundRecord) => ({ round: r.round, pairs: r.pairs, fields: r.fields,
  fighters: r.fighters.map(toHex), hp: [r.hpA, r.hpB], ticks: r.t, winner: r.winner });

export function aRoom(o: ARoomOptions = {}): Handler {
  const breedMs = o.breedMs ?? BREED_MS;
  const fieldMs = o.fieldMs ?? FIELD_MS;
  const draw = o.seed ?? (() => randomInt(0, 2 ** 32 - 1));

  // A side is waited for while it has not committed and its seat is not empty
  // for good.
  const waiting = (s: State, side: Side) =>
    !s.vacant[side] && (s.m.phase === "breed" ? s.pairs[side] : s.fields[side]) === null;

  const timeoutStream = (s: State, side: Side) =>
    stream(s.seed, STREAM_TIMEOUT, s.m.round, side * 2 + (s.m.phase === "breed" ? 0 : 1));

  function randomPair(s: State, side: Side): Pair {
    const r = timeoutStream(s, side), n = s.m.herds[side].length;
    const i = int(r, n);
    let j = int(r, n - 1);
    if (j >= i) j++;
    return [i, j];
  }

  function beginBreed(room: Room): Outbound[] {
    const s = st(room);
    s.pairs = [null, null];
    room.deadline = Date.now() + breedMs;
    return [{ to: "both", msg: { t: "accepted", do: "breed", round: s.m.round, rounds: ROUNDS,
      deadline: room.deadline, herds: herdsOf(s.m), wins: s.m.wins,
      released: s.m.released.map(r => r.map(creature)), timeouts: s.timeouts } }];
  }

  function finish(room: Room, forfeit: [boolean, boolean] | null): Outbound[] {
    const s = st(room);
    s.done = true;
    room.deadline = null;
    const m = s.m;
    const herds = [m.herds[0].length, m.herds[1].length];
    const end = forfeit
      ? { winner: forfeit[0] && forfeit[1] ? null : forfeit[0] ? 1 : 0, by: "forfeit", wins: m.wins, herds,
          reason: "forfeit", forfeit }
      : { ...m.result!, reason: "played", forfeit: [false, false] };
    return [{ to: "both", msg: { t: "result", ...end, timeouts: s.timeouts,
      seed: s.seed, decisions: decisions(m), hash: hash(m) } }];
  }

  // Both commits are in, or the clock ran out, or the only side not in has
  // left: count timeouts, forfeit, or reveal and move on.
  function resolve(room: Room): Outbound[] {
    const s = st(room), m = s.m;
    const commits = m.phase === "breed" ? s.pairs : s.fields;
    const timedOut: [boolean, boolean] = [commits[0] === null, commits[1] === null];
    for (const side of [0, 1] as Side[]) s.timeouts[side] = timedOut[side] ? s.timeouts[side] + 1 : 0;
    const forfeit: [boolean, boolean] = [s.timeouts[0] >= FORFEIT_AFTER, s.timeouts[1] >= FORFEIT_AFTER];
    if (forfeit[0] || forfeit[1]) return finish(room, forfeit);

    if (m.phase === "breed") {
      const pairs = ([0, 1] as Side[]).map(side => s.pairs[side] ?? randomPair(s, side)) as [Pair, Pair];
      const round = m.round;
      applyBreed(m, pairs);
      s.fields = [null, null];
      room.deadline = Date.now() + fieldMs;
      return [{ to: "both", msg: { t: "accepted", do: "litters", round, pairs, timedOut,
        litters: littersOf(m), deadline: room.deadline, timeouts: s.timeouts } }];
    }

    const fields = ([0, 1] as Side[]).map(side => s.fields[side] ?? int(timeoutStream(s, side), LITTER)) as [number, number];
    applyField(m, fields);
    const out: Outbound[] = [{ to: "both", msg: { t: "accepted", do: "fight",
      ...record(m.history[m.history.length - 1]), timedOut, wins: m.wins, timeouts: s.timeouts } }];
    return out.concat(m.phase === "over" ? finish(room, null) : beginBreed(room));
  }

  const error = (side: Side, reason: string): Outbound[] => [{ to: side, msg: { t: "error", reason } }];

  return {
    start(room) {
      const seed = draw() >>> 0;
      room.state = { m: newMatch(seed), seed, pairs: [null, null], fields: [null, null],
                     timeouts: [0, 0], vacant: [false, false], done: false } satisfies State;
      return [
        { to: "both", msg: { t: "accepted", do: "rules", rounds: ROUNDS, toWin: TO_WIN, litter: LITTER,
          herdLimit: HERD_LIMIT, forfeitAfter: FORFEIT_AFTER, breedMs, fieldMs } },
        ...beginBreed(room),
      ];
    },

    act(room, side, msg) {
      const s = st(room), m = s.m;
      if (msg.do === "sync") {
        // Everything public, plus this side's own pending commit. Never the
        // other side's, and never the seed before the result.
        const phase = s.done ? "over" : m.phase;
        const mine = s.done ? null : m.phase === "breed" ? s.pairs[side] : s.fields[side];
        const theirs = s.done ? null : m.phase === "breed" ? s.pairs[other(side)] : s.fields[other(side)];
        return [{ to: side, msg: { t: "accepted", do: "sync", round: m.round, rounds: ROUNDS, phase,
          deadline: room.deadline, herds: herdsOf(m), wins: m.wins,
          pairs: m.phase === "field" ? m.pairs : null, litters: m.phase === "field" ? littersOf(m) : null,
          history: m.history.map(record), timeouts: s.timeouts, done: s.done,
          mine, opponentCommitted: theirs !== null } }];
      }
      if (msg.do !== "pair" && msg.do !== "field") return error(side, "unknown action");
      if (s.done) return error(side, "match over");
      if (msg.round !== m.round) return error(side, "wrong round");
      const want = msg.do === "pair" ? "breed" : "field";
      if (m.phase !== want) return error(side, "wrong phase");

      let ack: Outbound;
      if (msg.do === "pair") {
        if (!validPair(m, side, msg.pair)) return error(side, "bad pair");
        if (s.pairs[side] !== null) return error(side, "already committed");
        const pair: Pair = [msg.pair[0], msg.pair[1]];
        s.pairs[side] = pair;
        ack = { to: side, msg: { t: "accepted", do: "pair", round: m.round, pair } };
      } else {
        if (!validField(msg.young)) return error(side, "bad young");
        if (s.fields[side] !== null) return error(side, "already committed");
        s.fields[side] = msg.young;
        ack = { to: side, msg: { t: "accepted", do: "field", round: m.round, young: msg.young } };
      }
      const out: Outbound[] = [ack,
        { to: other(side), msg: { t: "accepted", do: "opponentCommitted", round: m.round, phase: want } }];
      return waiting(s, other(side)) ? out : out.concat(resolve(room));
    },

    tick(room) {
      const s = st(room);
      if (s.done) return [];
      return resolve(room);
    },

    // A's rule for a seat nobody is sitting in (section 3.4): the match goes on.
    //
    //   gone  nothing changes. The clock keeps running; the seat times out.
    //   back  nothing changes.
    //   left  the seat is empty for good. It times out at once from now on,
    //         so a phase waiting only on it resolves now.
    seat(room, side, event) {
      const s = st(room);
      if (s.done || event !== "left") return [];
      s.vacant[side] = true;
      return waiting(s, other(side)) ? [] : resolve(room);
    },
  };
}
