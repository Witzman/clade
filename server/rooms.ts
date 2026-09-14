// Sockets, identities, the queue and the room map. Workshop issue #25,
// technical plan §5.2, §5.4, §6.
//
// The server owns everything that is not a room's rules: which socket is
// which player, pairing, the per-room clock, the reconnect grace period, the
// MAX_WS cap and dead-client detection. A room's rules are a Handler (types.ts).

import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Genome } from "../core/index.ts";
import type { Handler, Outbound, Room, SeatEvent, Side } from "./types.ts";
import { RESULT } from "./types.ts";
import { testRoom } from "./testroom/room.ts";
import { checkDecisions, replay, toHex } from "./testroom/run.ts";
import { computerSeat } from "./testroom/computer.ts";
import type { Seat } from "./testroom/computer.ts";

export type Options = {
  maxWs: number;          // MAX_WS: refuse sockets beyond this with {t:"full"}
  graceMs: number;        // a disconnected player keeps their seat this long
  turnMs: number;         // the test room's decision clock
  pingMs: number;         // dead-client detection
  logDesync: boolean;     // LOG_DESYNC
  log: (line: string) => void;
  computerThinkMs?: [number, number];
  keepComputerFrames?: boolean;
};

type Conn = {
  send(text: string): void;
  close(code: number, reason: string): void;
  ua: string;
  computer: boolean;
  session: Session | null;
};

type Session = {
  id: string; name: string; variant: string;
  conn: Conn | null;
  herd: Genome[] | null;
  room: Room | null; side: Side;
  level: number;
  grace: ReturnType<typeof setTimeout> | null;
  computer: boolean;
};

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const other = (s: Side): Side => (s === 0 ? 1 : 0);
const token = () => randomBytes(8).toString("hex");

export function createRooms(opts: Options) {
  // A Map, not an object: `handlers["constructor"]` on an object literal is
  // Object.prototype.constructor, which is truthy and is not a handler (#34).
  const handlers = new Map<string, Handler>([["test", testRoom(opts.turnMs)]]);
  const rooms = new Map<string, Room>();
  const sessions = new Map<string, Session>();
  const clocks = new Map<string, ReturnType<typeof setTimeout>>();
  const waiting: Session[] = [];
  const tickets = new Map<string, Session>();
  const seats: Seat[] = [];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  let stopping = false;

  const sendTo = (conn: Conn | null, msg: object) => conn?.send(JSON.stringify(msg));
  const sessionOf = (room: Room, side: Side) => {
    const s = sessions.get(room.players[side].id);
    return s && s.room === room ? s : null;
  };

  // ------------------------------------------------------------ rooms
  function dispatch(room: Room, out: Outbound[]) {
    let ended = false;
    for (const o of out) {
      const text = JSON.stringify(o.msg);
      for (const side of o.to === "both" ? [0, 1] as Side[] : [o.to]) sessionOf(room, side)?.conn?.send(text);
      if (o.msg.t === RESULT) ended = true;
    }
    clearTimeout(clocks.get(room.id));
    clocks.delete(room.id);
    if (ended) return endRoom(room);
    if (room.deadline !== null && rooms.has(room.id) && !stopping) {
      clocks.set(room.id, setTimeout(() => {
        clocks.delete(room.id);
        const h = handlers.get(room.variant);
        if (rooms.has(room.id) && h?.tick) guard(room, () => dispatch(room, h.tick!(room)));
      }, Math.max(0, room.deadline - Date.now())));
    }
  }

  function endRoom(room: Room) {
    clearTimeout(clocks.get(room.id));
    clocks.delete(room.id);
    rooms.delete(room.id);
    for (const side of [0, 1] as Side[]) {
      const s = sessionOf(room, side);
      if (!s) continue;
      s.room = null;
      if (s.computer) { s.conn?.close(1000, "match over"); sessions.delete(s.id); }
      else if (!s.conn) { clearTimeout(s.grace!); sessions.delete(s.id); }
    }
  }

  // A seat emptied, filled again, or emptied for good. The protocol had no
  // server->client message for it, so a player whose opponent walked out was
  // told nothing and could lose to an empty seat (#38).
  //
  // The server sends the notification — it owns sockets and the grace period,
  // and every variant inherits the message whether or not it implements a
  // rule. The handler decides what an empty seat *means*, and the notification
  // carries the clock as the handler left it, so a room that stops the clock
  // while a seat is empty can say so in the same frame.
  const SEAT_DO: Record<SeatEvent, string> =
    { gone: "opponentGone", back: "opponentBack", left: "opponentLeft" };

  function seatChanged(room: Room, side: Side, event: SeatEvent) {
    if (!rooms.has(room.id)) return;
    const h = handlers.get(room.variant);
    guard(room, () => {
      const out = h?.seat?.(room, side, event) ?? [];
      const msg: Record<string, unknown> = { t: "accepted", do: SEAT_DO[event], deadline: room.deadline };
      if (event === "gone") msg.grace = opts.graceMs;
      dispatch(room, [{ to: other(side), msg } as Outbound, ...out]);
    });
  }

  function match(a: Session, b: Session) {
    const room: Room = {
      id: token(), variant: a.variant, seed: randomInt(0, 2 ** 32 - 1) >>> 0,
      players: [a, b].map(s => ({ id: s.id, name: s.name, herd: s.herd!, computer: s.computer })) as Room["players"],
      state: null, lastActive: Date.now(), deadline: null,
    };
    rooms.set(room.id, room);
    [a, b].forEach((s, side) => { s.room = room; s.side = side as Side; });
    [a, b].forEach(s => sendTo(s.conn, matched(room, s.side)));
    opts.log(`room ${room.id} ${room.variant} ${a.id} vs ${b.id}${b.computer ? " (computer)" : ""}`);
    guard(room, () => dispatch(room, handlers.get(room.variant)!.start(room)));
  }

  const matched = (room: Room, side: Side) => {
    const opp = room.players[other(side)];
    return { t: "matched", room: room.id, side, seed: room.seed,
             opponent: { name: opp.name, computer: opp.computer, herd: opp.herd.map(toHex) } };
  };

  function seatComputer(human: Session) {
    const ticket = token();
    tickets.set(ticket, human);
    let closed = false;
    const conn: Conn = {
      // Asynchronous both ways, as a network is: no re-entrancy into a room
      // handler, and the seat sees frames in the order a socket would.
      send: text => { setTimeout(() => { if (!closed) seat.receive(text); }, 0); },
      // Deferred like the sends, so frames already on their way (the result)
      // arrive before the close, as they would on a socket.
      close: () => { setTimeout(() => { closed = true; }, 0); },
      ua: "computer", computer: true, session: null,
    };
    const seat = computerSeat({
      id: `cpu-${token()}`, ticket, seed: randomInt(0, 2 ** 32 - 1), variant: human.variant,
      level: human.level, thinkMs: opts.computerThinkMs, keepFrames: opts.keepComputerFrames,
      toServer: text => { setTimeout(() => { if (!closed) inbound(conn, text); }, 0); },
    });
    if (opts.keepComputerFrames) seats.push(seat);
  }

  // ------------------------------------------------------------ inbound
  // A handler that throws must cost one socket, not the process: three
  // variants are about to be written against this interface (#34).
  function inbound(conn: Conn, text: string) {
    try {
      handle(conn, text);
    } catch (e) {
      opts.log(`inbound failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      sendTo(conn, { t: "error", reason: "server error" });
      conn.close(1011, "server error");
    }
  }

  // The same for a room's own clock, which runs on a timer with no socket to
  // blame: log it and end the room, rather than let the timer throw.
  function guard(room: Room, fn: () => void) {
    try {
      fn();
    } catch (e) {
      opts.log(`room ${room.id} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      const text = JSON.stringify({ t: "error", reason: "server error" });
      for (const side of [0, 1] as Side[]) sessionOf(room, side)?.conn?.send(text);
      endRoom(room);
    }
  }

  function handle(conn: Conn, text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return sendTo(conn, { t: "error", reason: "bad json" }); }
    if (!m || typeof m.t !== "string") return sendTo(conn, { t: "error", reason: "bad message" });
    if (m.t === "hello") return hello(conn, m);
    const s = conn.session;
    if (!s || s.conn !== conn) return sendTo(conn, { t: "error", reason: "hello first" });

    switch (m.t) {
      case "enter": return enter(s, m);
      case "queue": return queue(s, m);
      case "act": {
        if (!s.room) return sendTo(conn, { t: "error", reason: "not in a match" });
        s.room.lastActive = Date.now();
        return dispatch(s.room, handlers.get(s.room.variant)!.act(s.room, s.side, m));
      }
      case "leave": return leave(s);
      default: return sendTo(conn, { t: "error", reason: "unknown message" });
    }
  }

  function hello(conn: Conn, m: any) {
    const bad = (reason: string) => sendTo(conn, { t: "error", reason });
    if (m.v !== 1) return bad("unsupported version");
    if (typeof m.id !== "string" || !ID.test(m.id)) return bad("bad id");
    if (m.id.startsWith("cpu-") !== conn.computer) return bad("bad id");
    if (typeof m.variant !== "string" || !handlers.has(m.variant)) return bad("unknown variant");
    const name = typeof m.name === "string" ? m.name.slice(0, 24) : "";

    let s = sessions.get(m.id);
    if (s && s.variant !== m.variant && !s.room) s = undefined;
    // A seat whose socket had dropped and whose grace period is still running:
    // the opponent was told "gone" and has to be told "back" (#38). A second
    // tab replacing a live socket is not that — nobody was ever told anything.
    const returning = !!s && !s.conn && !!s.room;
    if (s) {
      if (s.conn && s.conn !== conn) {
        // The same identity in a second tab or after a network change: the
        // newest socket wins, the old one is told why.
        sendTo(s.conn, { t: "error", reason: "replaced" });
        s.conn.session = null;
        s.conn.close(4000, "replaced");
      }
      if (s.grace) { clearTimeout(s.grace); s.grace = null; }
      s.conn = conn;
      if (name) s.name = name;
    } else {
      s = { id: m.id, name, variant: m.variant, conn, herd: null, room: null, side: 0, level: 0,
            grace: null, computer: conn.computer };
      sessions.set(s.id, s);
    }
    conn.session = s;
    sendTo(conn, { t: "welcome", serverTick: Date.now(), room: s.room?.id ?? null });
    if (s.room) {
      opts.log(`resume ${s.id} into room ${s.room.id}`);
      sendTo(conn, matched(s.room, s.side));
      if (returning) seatChanged(s.room, s.side, "back");
    }
  }

  function enter(s: Session, m: any) {
    if (s.room) return sendTo(s.conn, { t: "error", reason: "in a match" });
    const decisions = checkDecisions(m.decisions);
    if (!Number.isInteger(m.runSeed) || m.runSeed < 0 || m.runSeed > 0xffffffff || !decisions
        || typeof m.stateHash !== "string")
      return sendTo(s.conn, { t: "error", reason: "bad run" });
    const t0 = performance.now();
    const run = replay(m.runSeed, decisions);
    const ms = (performance.now() - t0).toFixed(1);
    if (run.hash !== m.stateHash) {
      if (opts.logDesync) {
        opts.log(`DESYNC id=${s.id} runSeed=${m.runSeed} decisions=${decisions.length} ` +
                 `client=${m.stateHash.slice(0, 16)} server=${run.hash} replay=${ms}ms ua=${JSON.stringify(s.conn?.ua)}`);
      }
      s.herd = null;
      return sendTo(s.conn, { t: "error", reason: "desync" });
    }
    s.herd = run.herd;
    sendTo(s.conn, { t: "accepted", do: "enter", hash: run.hash, replayMs: Number(ms) });
  }

  function queue(s: Session, m: any) {
    if (s.room) return sendTo(s.conn, { t: "error", reason: "in a match" });
    if (!s.herd) return sendTo(s.conn, { t: "error", reason: "enter first" });
    s.level = Number.isInteger(m.level) ? m.level : 0;
    dequeue(s);

    if (m.vs === "seat") {
      const human = s.computer ? tickets.get(m.ticket) : undefined;
      tickets.delete(m.ticket);
      if (!human || !human.conn || human.room) { s.conn?.close(1000, "no seat"); sessions.delete(s.id); return; }
      return match(human, s);
    }
    if (m.vs === "computer") {
      sendTo(s.conn, { t: "accepted", do: "queued", vs: "computer" });
      return seatComputer(s);
    }
    const i = waiting.findIndex(w => w.variant === s.variant && w.level === s.level && w.conn && w.id !== s.id);
    if (i >= 0) return match(waiting.splice(i, 1)[0], s);
    waiting.push(s);
    sendTo(s.conn, { t: "accepted", do: "queued", vs: "person" });
  }

  function dequeue(s: Session) {
    const i = waiting.indexOf(s);
    if (i >= 0) waiting.splice(i, 1);
    for (const [k, v] of tickets) if (v === s) tickets.delete(k);
  }

  function leave(s: Session) {
    dequeue(s);
    const room = s.room;
    if (room) {
      s.room = null;
      if (s.grace) { clearTimeout(s.grace); s.grace = null; }
      const opp = sessionOf(room, other(s.side));
      if (!opp || opp.computer) endRoom(room);
      // Someone is still sitting there: tell them, and let the room's rule
      // decide what an abandoned match becomes (#38).
      else seatChanged(room, s.side, "left");
    }
    sendTo(s.conn, { t: "accepted", do: "left" });
  }

  function disconnected(conn: Conn) {
    const s = conn.session;
    if (!s || s.conn !== conn || stopping) return;
    s.conn = null;
    dequeue(s);
    if (!s.room) { sessions.delete(s.id); return; }
    s.grace = setTimeout(() => {
      sessions.delete(s.id);
      const room = s.room;
      if (!room) return;
      s.room = null;
      opts.log(`grace expired ${s.id} in room ${room.id}`);
      const opp = sessionOf(room, other(s.side));
      if (!opp || opp.computer) return endRoom(room);
      seatChanged(room, s.side, "left");
    }, opts.graceMs);
    seatChanged(s.room, s.side, "gone");
  }

  // ------------------------------------------------------------ sockets
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (wss.clients.size > opts.maxWs) {
      opts.log(`full: refused a socket (${wss.clients.size - 1} open, MAX_WS=${opts.maxWs})`);
      ws.send(JSON.stringify({ t: "full" }));
      ws.close(1013, "full");
      return;
    }
    const conn: Conn = {
      send: text => { if (ws.readyState === ws.OPEN) ws.send(text); },
      close: (code, reason) => ws.close(code, reason),
      ua: String(req.headers["user-agent"] ?? ""), computer: false, session: null,
    };
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendTo(conn, { t: "error", reason: "text only" });
      inbound(conn, data.toString());
    });
    ws.on("close", () => disconnected(conn));
    ws.on("error", e => opts.log(`ws error: ${e.message}`));
  });

  // ws ping for dead-client detection. The proxy chain does not need it
  // (a 310 s idle hold survived, #15); a vanished iPad does.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.pingMs);

  return {
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
    },
    stats: () => ({ connections: wss.clients.size, rooms: rooms.size, sessions: sessions.size,
                    waiting: waiting.length }),
    seats,
    // A redeploy: every client is told, then closed with 1012 (service restart).
    shutdown() {
      stopping = true;
      clearInterval(pinger);
      for (const t of clocks.values()) clearTimeout(t);
      for (const s of sessions.values()) if (s.grace) clearTimeout(s.grace);
      const open = [...wss.clients];
      const closed = Promise.all(open.map(ws => new Promise<void>(done => {
        if (ws.readyState === ws.CLOSED) return done();
        ws.once("close", () => done());
      })));
      for (const ws of open) {
        ws.send(JSON.stringify({ t: "error", reason: "restarting" }));
        ws.close(1012, "restarting");
      }
      // A client that never answers the close frame does not hold the exit.
      return Promise.race([closed, new Promise<void>(done => setTimeout(done, 1000).unref())]);
    },
  };
}
