// The shapes shared by the server and every room handler. Workshop issue #25,
// technical plan §6.2-§6.3.
//
// A room is a plain object and a handler is three functions. That is the
// whole interface: no base class, no lifecycle beyond these, no registry.

import type { Genome } from "../core/index.ts";

export type Side = 0 | 1;

export type Player = {
  id: string;            // the localStorage identity, or "cpu-..." for a computer seat
  name: string;
  herd: Genome[];        // verified by replay on `enter`
  computer: boolean;
};

export type Room = {
  id: string;
  variant: string;
  seed: number;          // server-issued, never chosen by a client
  players: [Player, Player];
  state: unknown;        // the handler's own business
  lastActive: number;
  // Set by the handler: when `tick` should run (ms since epoch), or null for
  // no clock. The server re-arms one setTimeout per room after every call.
  deadline: number | null;
};

export type Outbound = { to: Side | "both"; msg: { t: string; [k: string]: unknown } };

// What the server tells a handler about a seat whose player is not there.
// The server owns sockets and the grace period, so only it can know these.
//
//   "gone"  the socket dropped; the grace period is running
//   "back"  the same identity reconnected inside the grace period
//   "left"  the seat is empty for good: an explicit `leave`, or a grace period
//           that expired
export type SeatEvent = "gone" | "back" | "left";

export type Handler = {
  // Amended from plan §6.3 (which returns void): the first round has to be
  // announced, so start returns what to send.
  start(room: Room): Outbound[];
  act(room: Room, side: Side, msg: any): Outbound[];
  tick?(room: Room): Outbound[];
  // Optional, added for workshop #38. The server notifies the other side
  // either way — every variant inherits that, which is what was missing — and
  // this is where a variant's own rule for an empty seat lives: forfeit, play
  // on against the clock, seat the computer, or stop the clock and wait.
  seat?(room: Room, side: Side, event: SeatEvent): Outbound[];
};

// The server ends a room when a handler emits a message of this type.
export const RESULT = "result";
