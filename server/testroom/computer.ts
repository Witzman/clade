// The computer seat. Workshop issue #25, design §8.1.
//
// The computer plays through exactly the protocol a browser uses. It is built
// from two functions:
//
//   toServer(text)   -- JSON strings into the same inbound handler a socket feeds
//   receive(text)    -- JSON strings the server sends to this side's "socket"
//
// It imports nothing from the room code and holds no reference to a room, so
// it can only know what the server serialises to its side. The server never
// serialises a pending commit to the other side, so the computer is
// structurally unable to see one.

import { rng, int, u32, express, stats, fight, fightResult } from "../../core/index.ts";
import { replay, autoDecisions, fromHex } from "./run.ts";

export type Seat = { receive(text: string): void; frames: string[] };

export function computerSeat(opts: {
  id: string; ticket: string; seed: number; variant: string; level: number;
  toServer: (text: string) => void;
  thinkMs?: [number, number];   // commit after a delay in this range
  keepFrames?: boolean;         // tests inspect what the seat was sent
}): Seat {
  const r = rng(opts.seed);
  const [lo, hi] = opts.thinkMs ?? [300, 1500];
  const send = (m: object) => opts.toServer(JSON.stringify(m));
  const frames: string[] = [];
  let side = 0;

  const runSeed = u32(r);
  const decisions = autoDecisions();
  send({ t: "hello", v: 1, id: opts.id, name: "Computer", variant: opts.variant });
  send({ t: "enter", runSeed, decisions, stateHash: replay(runSeed, decisions).hash });
  send({ t: "queue", level: opts.level, vs: "seat", ticket: opts.ticket });

  const choose = (options: string[][]) => {
    // Best total result against every option the opponent could field. The
    // options are public; the opponent's choice is not, and is not available.
    const mine = options[side].map(h => stats(express(fromHex(h)!)));
    const theirs = options[side === 0 ? 1 : 0].map(h => stats(express(fromHex(h)!)));
    let best = -1e9, pick = int(r, mine.length);
    mine.forEach((m, i) => {
      const score = theirs.reduce((s, t) => s + fightResult(fight(m, t)), 0) + int(r, 2) * 0.5;
      if (score > best) { best = score; pick = i; }
    });
    return pick;
  };

  return {
    frames,
    receive(text) {
      if (opts.keepFrames) frames.push(text);
      const m = JSON.parse(text);
      if (m.t === "matched") side = m.side;
      if (m.t === "accepted" && m.do === "round") {
        const pick = choose(m.options);
        setTimeout(() => send({ t: "act", do: "commit", round: m.round, pick }), lo + int(r, hi - lo + 1));
      }
    },
  };
}
