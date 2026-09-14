// The throwaway test room. Workshop issue #25. NOT a variant.
//
// It exists to prove the shape two variants need (design §8.1): a turn-based
// 1v1 with a server-issued match seed, where both sides commit a hidden choice
// and the server reveals both only when both have committed or the clock has
// run out, then resolves a fight with core/ and sends the result.
//
// Each of ROUNDS rounds, each side chooses one of its options: its three
// verified creatures plus one young the server breeds from (match seed, round,
// side). Options are public; the choice is hidden until the reveal.

import { rng, int, breed, express, stats, fight, fightResult } from "../../core/index.ts";
import type { Genome } from "../../core/index.ts";
import type { Handler, Outbound, Room, Side } from "../types.ts";
import { fnv, hex8, toHex } from "./run.ts";

export const ROUNDS = 3;

type Round = { options: [Genome[], Genome[]]; commits: [number | null, number | null] };
type Reveal = { round: number; picks: [number, number]; timedOut: [boolean, boolean];
                winner: Side | null; ticks: number; hp: [number, number] };
type State = { round: number; current: Round; wins: [number, number]; history: Reveal[];
               done: boolean; turnMs: number;
               // ms left on the clock while a seat is empty, or null (#38).
               paused: number | null };

// Distinct streams from one match seed. Integer mixing only.
const stream = (seed: number, round: number, side: number, purpose: number) =>
  rng((Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(round + 1, 0xc2b2ae35)
       + Math.imul(side + 1, 0x27d4eb2f) + Math.imul(purpose, 0x165667b1)) >>> 0);

const PURPOSE_YOUNG = 1, PURPOSE_TIMEOUT = 2;

export function optionsFor(room: Room, round: number): [Genome[], Genome[]] {
  return [0, 1].map(side => {
    const herd = room.players[side].herd;
    const young = breed(herd[round % herd.length], herd[(round + 1) % herd.length],
                        stream(room.seed, round, side, PURPOSE_YOUNG)).child;
    return [...herd, young];
  }) as [Genome[], Genome[]];
}

// Fight two genomes. Side 0's creature is A.
export function resolve(a: Genome, b: Genome) {
  const f = fight(stats(express(a)), stats(express(b)));
  const r = fightResult(f);
  return { winner: (r > 0 ? 0 : r < 0 ? 1 : null) as Side | null, ticks: f.t,
           hp: [f.hpA / f.A.hp, f.hpB / f.B.hp] as [number, number] };
}

// A hash of the whole match, recomputable by a client from public data: the
// seed, every revealed pick and every fight's final HP bits.
export function matchHash(seed: number, history: { picks: number[]; hp: number[] }[]): string {
  const f64 = new Float64Array(1), bytes = new Uint8Array(f64.buffer);
  let h = fnv([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, (seed >>> 24) & 255]);
  for (const r of history) {
    h = fnv(r.picks, h);
    for (const x of r.hp) { f64[0] = x; h = fnv(bytes, h); }
  }
  return hex8(h);
}

const st = (room: Room) => room.state as State;
const optionsMsg = (s: State) => s.current.options.map(side => side.map(toHex));

function beginRound(room: Room, round: number): Outbound[] {
  const s = st(room);
  s.round = round;
  s.current = { options: optionsFor(room, round), commits: [null, null] };
  room.deadline = Date.now() + s.turnMs;
  return [{ to: "both", msg: { t: "accepted", do: "round", round, rounds: ROUNDS,
                               deadline: room.deadline, options: optionsMsg(s) } }];
}

function reveal(room: Room): Outbound[] {
  const s = st(room);
  const c = s.current;
  const timedOut: [boolean, boolean] = [c.commits[0] === null, c.commits[1] === null];
  const picks = [0, 1].map(side => c.commits[side] ??
    int(stream(room.seed, s.round, side, PURPOSE_TIMEOUT), c.options[side].length)) as [number, number];
  const fightOut = resolve(c.options[0][picks[0]], c.options[1][picks[1]]);
  if (fightOut.winner !== null) s.wins[fightOut.winner]++;
  const rev: Reveal = { round: s.round, picks, timedOut, ...fightOut };
  s.history.push(rev);
  const out: Outbound[] = [{ to: "both", msg: { t: "accepted", do: "reveal", ...rev, wins: s.wins } }];
  if (s.round + 1 < ROUNDS) return out.concat(beginRound(room, s.round + 1));
  s.done = true;
  room.deadline = null;
  const winner = s.wins[0] > s.wins[1] ? 0 : s.wins[1] > s.wins[0] ? 1 : null;
  out.push({ to: "both", msg: { t: "result", winner, wins: s.wins, hash: matchHash(room.seed, s.history) } });
  return out;
}

export function testRoom(turnMs: number): Handler {
  return {
    start(room) {
      room.state = { round: 0, current: null, wins: [0, 0], history: [], done: false, turnMs,
                     paused: null } as unknown as State;
      return beginRound(room, 0);
    },

    act(room, side, msg) {
      const s = st(room);
      if (msg.do === "sync") {
        // Everything public, plus this side's own pending commit. Never the
        // other side's.
        const mine = s.done ? null : s.current.commits[side];
        const theirs = s.done ? null : s.current.commits[side === 0 ? 1 : 0];
        return [{ to: side, msg: { t: "accepted", do: "sync", round: s.round, rounds: ROUNDS,
          deadline: room.deadline, options: optionsMsg(s), wins: s.wins, history: s.history,
          done: s.done, myCommit: mine, opponentCommitted: theirs !== null } }];
      }
      if (msg.do === "commit") {
        if (s.done) return [{ to: side, msg: { t: "error", reason: "match over" } }];
        if (msg.round !== s.round) return [{ to: side, msg: { t: "error", reason: "wrong round" } }];
        const n = s.current.options[side].length;
        if (!Number.isInteger(msg.pick) || msg.pick < 0 || msg.pick >= n)
          return [{ to: side, msg: { t: "error", reason: "bad pick" } }];
        if (s.current.commits[side] !== null) return [{ to: side, msg: { t: "error", reason: "already committed" } }];
        s.current.commits[side] = msg.pick;
        const other: Side = side === 0 ? 1 : 0;
        const out: Outbound[] = [
          { to: side, msg: { t: "accepted", do: "commit", round: s.round, pick: msg.pick } },
          { to: other, msg: { t: "accepted", do: "opponentCommitted", round: s.round } },
        ];
        return s.current.commits[other] !== null ? out.concat(reveal(room)) : out;
      }
      return [{ to: side, msg: { t: "error", reason: "unknown action" } }];
    },

    tick(room) {
      const s = st(room);
      if (s.done) return [];
      return reveal(room);
    },

    // This room's rule for a seat nobody is sitting in (#38). It is a rule,
    // not a server default: another variant may keep playing, or seat the
    // computer.
    //
    //   gone  stop the clock. Losing rounds to a drawn pick while the other
    //         side's grace period runs is how a player lost to an empty seat.
    //   back  start it again with what was left on it.
    //   left  the match is over and the player who is still here has won it.
    //         `wins` is the score as actually played, so a forfeit does not
    //         pretend to be a 3-0; `reason` says why it ended.
    seat(room, side, event) {
      const s = st(room);
      if (s.done) return [];
      if (event === "gone") {
        if (room.deadline !== null) {
          s.paused = Math.max(0, room.deadline - Date.now());
          room.deadline = null;
        }
        return [];
      }
      if (event === "back") {
        if (s.paused !== null) { room.deadline = Date.now() + s.paused; s.paused = null; }
        return [];
      }
      s.done = true;
      s.paused = null;
      room.deadline = null;
      return [{ to: "both", msg: { t: "result", winner: (side === 0 ? 1 : 0) as Side, wins: s.wins,
                                  reason: "opponentLeft", hash: matchHash(room.seed, s.history) } }];
    },
  };
}
