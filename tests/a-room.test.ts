// Variant A's server room, exercised in process. Workshop issue #64.
//
//   node --test tests/a-room.test.ts
//
// Real sockets (Node 22's global WebSocket) against a real listening server on
// an ephemeral port, as tests/server.test.ts does. The point is what each
// client can and cannot receive, so nothing is mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startServer } from "../server/main.ts";
import type { ServerOptions } from "../server/main.ts";
import { replay, hash, validPair, LITTER } from "../server/a/rules.ts";
import { BREED_MS, FIELD_MS, FORFEIT_AFTER } from "../server/a/room.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function server(o: Partial<ServerOptions> = {}) {
  return startServer({ port: 0, webRoot: join(import.meta.dirname, "..", "web"), log: () => {}, ...o });
}

type Client = { ws: WebSocket; frames: any[]; raw: string[]; closed: Promise<{ code: number }>;
  send(m: object): void; wait(pred: (m: any) => boolean, ms?: number): Promise<any> };

function client(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: any[] = [], raw: string[] = [];
  let wake = () => {};
  ws.onmessage = e => { raw.push(String(e.data)); frames.push(JSON.parse(String(e.data))); wake(); };
  const closed = new Promise<{ code: number }>(r => ws.addEventListener("close", e => r({ code: (e as { code: number }).code })));
  const c: Client = {
    ws, frames, raw, closed,
    send: m => ws.send(JSON.stringify(m)),
    async wait(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = frames.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(frames).slice(-800)}`);
        await new Promise<void>(r => { wake = r; setTimeout(r, 20); });
      }
    },
  };
  return new Promise((ok, fail) => { ws.onopen = () => ok(c); ws.onerror = () => fail(new Error("ws error")); });
}

// A has no run: hello, then queue.
async function person(port: number, id: string) {
  const c = await client(port);
  c.send({ t: "hello", v: 1, id, name: id, variant: "a" });
  await c.wait(m => m.t === "welcome");
  c.send({ t: "queue", level: 0, vs: "person" });
  return c;
}

async function pairUp(port: number, ida: string, idb: string) {
  const a = await person(port, ida);
  const b = await person(port, idb);
  const ma = await a.wait(m => m.t === "matched");
  const mb = await b.wait(m => m.t === "matched");
  // Index the clients by side, so a test can speak of side 0 and side 1.
  const bySide: [Client, Client] = ma.side === 0 ? [a, b] : [b, a];
  return { a, b, ma, mb, bySide };
}

// The frame-level guarantee. Before the frame that reveals a commit (`reveal`)
// for `round`, nothing one side has received carries the other side's commit.
// The only frame allowed to carry `key` is the side's own acknowledgement
// (`ack`), exactly once.
function assertNoLeak(frames: any[], raw: string[], round: number, reveal: string, ack: string, key: string) {
  let ownAcks = 0;
  const pattern = new RegExp(`"${key}"`);
  for (let i = 0; i < frames.length; i++) {
    const m = frames[i];
    if (m.t === "accepted" && m.do === reveal && m.round === round) break;
    if (m.round !== round) continue;
    if (m.do === ack) { ownAcks++; continue; }
    if (m.do === "opponentCommitted") assert.deepEqual(Object.keys(m).sort(), ["do", "phase", "round", "t"]);
    assert.doesNotMatch(raw[i], pattern, `leaking frame before ${reveal}: ${raw[i]}`);
  }
  assert.ok(ownAcks <= 1, `round ${round}: ${ownAcks} ${ack} frames reached one side`);
}

// The result carries the seed and the log: a client can check the whole match.
function assertVerifiable(res: any) {
  const m = replay(res.seed, res.decisions);
  assert.ok(m, "the result's decision log replays");
  assert.equal(hash(m!), res.hash, "the result hash is recomputable from the seed and the log");
  return m!;
}

// ---------------------------------------------------------------- a full match

test("two people play a full match; neither receives the other's pair or field commit before the reveal", async () => {
  const s = await server({ aClockMs: [5000, 5000] });
  try {
    const { a, b, ma, mb, bySide } = await pairUp(s.port, "duel-a-0001", "duel-b-0002");
    assert.equal(ma.room, mb.room);
    assert.notEqual(ma.side, mb.side);
    const rules = await a.wait(m => m.do === "rules");
    assert.equal(rules.breedMs, 5000);

    let round = 1, res: any = null;
    const committed: { pairs: number[][]; fields: number[] }[] = [];
    while (!res) {
      const [b0, b1] = await Promise.all(bySide.map(c => c.wait(m => m.do === "breed" && m.round === round)));
      assert.deepEqual(b0.herds, b1.herds, "both herds are public to both");
      assert.ok(b0.deadline > Date.now());

      // Breed. Alternate who commits first, so both directions are inspected.
      const [first, second] = round % 2 === 1 ? [bySide[0], bySide[1]] : [bySide[1], bySide[0]];
      const sideOf = (c: Client) => (c === bySide[0] ? 0 : 1);
      const pairFor = (side: number) => { const n = b0.herds[side].length; return [round % n, (round + 2 + side) % n]; };
      const pairs = [pairFor(0), pairFor(1)];
      first.send({ t: "act", do: "pair", round, pair: pairs[sideOf(first)] });
      await second.wait(m => m.do === "opponentCommitted" && m.round === round && m.phase === "breed");
      await sleep(30);
      assert.equal(second.frames.some(m => m.do === "litters" && m.round === round), false);
      assertNoLeak(second.frames, second.raw, round, "litters", "pair", "pair");
      second.send({ t: "act", do: "pair", round, pair: pairs[sideOf(second)] });
      const [l0, l1] = await Promise.all(bySide.map(c => c.wait(m => m.do === "litters" && m.round === round)));
      assert.deepEqual(l0, l1, "both players see the same litters");
      assert.deepEqual(l0.pairs, pairs);
      assert.deepEqual(l0.timedOut, [false, false]);
      assert.equal(l0.litters[0].length, LITTER);
      assert.equal(l0.litters[1].length, LITTER);
      for (const c of bySide) assertNoLeak(c.frames, c.raw, round, "litters", "pair", "pair");

      // Field, the other side first this time.
      const fields = [round % LITTER, (round + 1) % LITTER];
      second.send({ t: "act", do: "field", round, young: fields[sideOf(second)] });
      await first.wait(m => m.do === "opponentCommitted" && m.round === round && m.phase === "field");
      await sleep(30);
      assert.equal(first.frames.some(m => m.do === "fight" && m.round === round), false);
      assertNoLeak(first.frames, first.raw, round, "fight", "field", "young");
      // The field commit must not surface under any name: a sync before the
      // reveal answers with this side's own commit only.
      first.send({ t: "act", do: "sync" });
      const sync = await first.wait(m => m.do === "sync" && m.round === round);
      assert.equal(sync.mine, null);
      assert.equal(sync.opponentCommitted, true);
      first.send({ t: "act", do: "field", round, young: fields[sideOf(first)] });
      const [f0, f1] = await Promise.all(bySide.map(c => c.wait(m => m.do === "fight" && m.round === round)));
      assert.deepEqual(f0, f1);
      assert.deepEqual(f0.fields, fields);
      assert.deepEqual(f0.timedOut, [false, false]);
      for (const c of bySide) assertNoLeak(c.frames, c.raw, round, "fight", "field", "young");
      committed.push({ pairs, fields });

      res = bySide[0].frames.find(m => m.t === "result") ?? null;
      if (!res) {
        await sleep(0);
        res = await Promise.race([
          bySide[0].wait(m => m.t === "result", 3000),
          bySide[0].wait(m => m.do === "breed" && m.round === round + 1, 3000).then(() => null),
        ]);
      }
      round++;
    }
    const [r0, r1] = await Promise.all(bySide.map(c => c.wait(m => m.t === "result")));
    assert.deepEqual(r0, r1);
    assert.equal(r0.reason, "played");
    assert.ok(committed.length >= 4 && committed.length <= 7, `${committed.length} rounds`);
    assert.deepEqual(r0.decisions, committed);

    const m = assertVerifiable(r0);
    assert.equal(m.phase, "over");
    assert.deepEqual({ winner: r0.winner, by: r0.by, wins: r0.wins, herds: r0.herds },
                     { ...m.result });
    // The rules seed is the room's own and appears in no frame before the result.
    assert.notEqual(r0.seed, ma.seed, "the rules seed is not the seed sent in matched");
    for (const c of bySide) {
      const before = c.raw.slice(0, c.frames.findIndex(f => f.t === "result"));
      assert.equal(before.some(t => t.includes(`"seed":${r0.seed}`)), false, "the rules seed leaked before the result");
    }
    await sleep(50);
    assert.equal(s.rooms.stats().rooms, 0);
    void b;
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- the clock

test("the clock reveals with random picks, and three consecutive timeouts forfeit", async () => {
  const s = await server({ aClockMs: [80, 80] });
  try {
    const { bySide } = await pairUp(s.port, "slow-a-0003", "slow-b-0004");
    const res = await bySide[0].wait(m => m.t === "result", 3000);
    const f = bySide[0].frames;
    const breed = f.find(m => m.do === "breed" && m.round === 1);
    const litters = f.filter(m => m.do === "litters");
    const fights = f.filter(m => m.do === "fight");
    // breed timeout (1), field timeout (2), breed timeout (3): forfeit.
    assert.equal(litters.length, 1);
    assert.equal(fights.length, 1);
    assert.deepEqual(litters[0].timedOut, [true, true]);
    assert.deepEqual(fights[0].timedOut, [true, true]);
    for (const side of [0, 1]) {
      const [i, j] = litters[0].pairs[side];
      assert.ok(Number.isInteger(i) && Number.isInteger(j) && i !== j && i >= 0 && j >= 0
                && i < breed.herds[side].length && j < breed.herds[side].length, `random pair ${i},${j}`);
      assert.ok(fights[0].fields[side] >= 0 && fights[0].fields[side] < LITTER);
    }
    assert.deepEqual([res.reason, res.by, res.winner, res.forfeit], ["forfeit", "forfeit", null, [true, true]]);
    assert.deepEqual(res.timeouts, [FORFEIT_AFTER, FORFEIT_AFTER]);
    // The random picks are part of the log, and the log still verifies.
    const m = assertVerifiable(res);
    assert.ok(validPair(m, 0, m.history[0].pairs[0]));
    assert.deepEqual((await bySide[1].wait(m => m.t === "result")).hash, res.hash);
    await sleep(50);
    assert.equal(s.rooms.stats().rooms, 0);
  } finally { await s.close(); }
});

test("timeouts must be consecutive: a commit resets them, and the side that stops playing forfeits", async () => {
  const s = await server({ aClockMs: [150, 150] });
  try {
    const { bySide } = await pairUp(s.port, "half-a-0005", "half-b-0006");
    const [p, idle] = bySide;
    // Side 0 commits every phase at once. Side 1 commits only round 1's field:
    // breed timeout (1), field commit (0), breed (1), field (2), breed (3).
    let res: any = null;
    for (let round = 1; !res; round++) {
      const breed = await p.wait(m => (m.do === "breed" && m.round === round) || m.t === "result", 3000);
      if (breed.t === "result") { res = breed; break; }
      p.send({ t: "act", do: "pair", round, pair: [0, 1] });
      const lit = await p.wait(m => (m.do === "litters" && m.round === round) || m.t === "result", 3000);
      if (lit.t === "result") { res = lit; break; }
      p.send({ t: "act", do: "field", round, young: 0 });
      if (round === 1) idle.send({ t: "act", do: "field", round, young: 2 });
      await p.wait(m => (m.do === "fight" && m.round === round) || m.t === "result", 3000);
      res = p.frames.find(m => m.t === "result") ?? null;
    }
    const f = p.frames;
    const litters = f.filter(m => m.do === "litters"), fights = f.filter(m => m.do === "fight");
    assert.deepEqual(litters.map(m => m.timedOut), [[false, true], [false, true]]);
    assert.deepEqual(fights.map(m => m.timedOut), [[false, false], [false, true]]);
    assert.deepEqual(litters.map(m => m.timeouts), [[0, 1], [0, 1]]);
    assert.deepEqual(fights.map(m => m.timeouts), [[0, 0], [0, 2]]);
    assert.equal(fights[0].fields[1], 2, "side 1's one commit was used");
    assert.deepEqual([res.reason, res.winner, res.forfeit, res.timeouts], ["forfeit", 0, [false, true], [0, 3]]);
    assertVerifiable(res);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- empty seats

test("a dropped seat keeps timing out while the clock runs, and play continues to a forfeit", async () => {
  const s = await server({ aClockMs: [150, 150], graceMs: 60000 });
  try {
    const { bySide } = await pairUp(s.port, "drop-a-0007", "drop-b-0008");
    const [p, dropper] = bySide;
    await p.wait(m => m.do === "breed" && m.round === 1);
    dropper.ws.close();
    const gone = await p.wait(m => m.do === "opponentGone", 2000);
    assert.notEqual(gone.deadline, null, "A does not stop the clock for a dropped seat");
    let res: any = null;
    for (let round = 1; !res; round++) {
      const breed = await p.wait(m => (m.do === "breed" && m.round === round) || m.t === "result", 3000);
      if (breed.t === "result") { res = breed; break; }
      p.send({ t: "act", do: "pair", round, pair: [1, 2] });
      const lit = await p.wait(m => (m.do === "litters" && m.round === round) || m.t === "result", 3000);
      if (lit.t === "result") { res = lit; break; }
      assert.deepEqual(lit.timedOut, [false, true]);
      p.send({ t: "act", do: "field", round, young: 1 });
      await p.wait(m => (m.do === "fight" && m.round === round) || m.t === "result", 3000);
      res = p.frames.find(m => m.t === "result") ?? null;
    }
    assert.deepEqual([res.reason, res.winner, res.forfeit], ["forfeit", 0, [false, true]]);
    assert.equal(p.frames.filter(m => m.do === "fight").length, 1, "one fight was played against the empty seat");
    assertVerifiable(res);
    await sleep(50);
    assert.equal(s.rooms.stats().rooms, 0);
  } finally { await s.close(); }
});

test("a seat left for good times out at once: the player still there does not sit out the clock", async () => {
  const s = await server({ aClockMs: [20000, 20000], graceMs: 60000 });
  try {
    const { bySide } = await pairUp(s.port, "quit-a-0009", "quit-b-0010");
    const [p, quitter] = bySide;
    await p.wait(m => m.do === "breed" && m.round === 1);
    const t0 = Date.now();
    quitter.send({ t: "leave" });
    await p.wait(m => m.do === "opponentLeft", 2000);
    p.send({ t: "act", do: "pair", round: 1, pair: [0, 4] });
    const lit = await p.wait(m => m.do === "litters" && m.round === 1, 2000);
    assert.deepEqual(lit.timedOut, [false, true]);
    p.send({ t: "act", do: "field", round: 1, young: 2 });
    await p.wait(m => m.do === "fight" && m.round === 1, 2000);
    p.send({ t: "act", do: "pair", round: 2, pair: [3, 1] });
    const res = await p.wait(m => m.t === "result", 2000);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms against 20 s clocks`);
    assert.deepEqual([res.reason, res.winner, res.forfeit], ["forfeit", 0, [false, true]]);
    assert.equal((await quitter.wait(m => m.do === "left")).t, "accepted");
    assert.equal(quitter.frames.some(m => m.t === "result"), false);
    await sleep(50);
    assert.equal(s.rooms.stats().rooms, 0);
  } finally { await s.close(); }
});

test("a reconnect resumes the match: sync gives this side's own commit and never the other's", async () => {
  const s = await server({ aClockMs: [20000, 20000], graceMs: 60000 });
  try {
    const { bySide } = await pairUp(s.port, "back-a-0011", "back-b-0012");
    const [p, q] = bySide;
    await q.wait(m => m.do === "breed" && m.round === 1);
    p.send({ t: "act", do: "pair", round: 1, pair: [2, 3] });
    await q.wait(m => m.do === "opponentCommitted");
    q.ws.close();
    await q.closed;
    const q2 = await client(s.port);
    q2.send({ t: "hello", v: 1, id: "back-b-0012", name: "b", variant: "a" });
    await q2.wait(m => m.t === "matched");
    await p.wait(m => m.do === "opponentBack", 2000);
    q2.send({ t: "act", do: "sync" });
    const sync = await q2.wait(m => m.do === "sync");
    assert.deepEqual([sync.phase, sync.round, sync.mine, sync.opponentCommitted], ["breed", 1, null, true]);
    assert.doesNotMatch(q2.raw.join("\n"), /"pair"/);
    p.send({ t: "act", do: "sync" });
    assert.deepEqual((await p.wait(m => m.do === "sync")).mine, [2, 3]);
    q2.send({ t: "act", do: "pair", round: 1, pair: [0, 1] });
    const lit = await q2.wait(m => m.do === "litters");
    assert.deepEqual(lit.pairs, [[2, 3], [0, 1]]);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- entry and limits

test("A has no run to enter and no server computer; bad moves are refused without ending the match", async () => {
  const s = await server();
  try {
    const c = await client(s.port);
    c.send({ t: "hello", v: 1, id: "entry-0013", name: "e", variant: "a" });
    await c.wait(m => m.t === "welcome");
    c.send({ t: "enter", runSeed: 1, decisions: [], stateHash: "x" });
    assert.equal((await c.wait(m => m.t === "error")).reason, "no entry");
    c.send({ t: "queue", level: 0, vs: "computer" });
    await c.wait(m => m.t === "error" && m.reason === "no computer seat");
    c.send({ t: "queue", level: 0, vs: "person" });
    assert.equal((await c.wait(m => m.do === "queued")).vs, "person");

    const d = await person(s.port, "entry-0014");
    const md = await d.wait(m => m.t === "matched");
    assert.deepEqual(md.opponent.herd, [], "A's players bring no herd; the room deals");
    await d.wait(m => m.do === "breed");
    const errors = async (msg: object, reason: string) => {
      const n = d.frames.filter(m => m.t === "error").length;
      d.send({ t: "act", ...msg });
      await d.wait(() => d.frames.filter(m => m.t === "error").length > n);
      assert.equal(d.frames.filter(m => m.t === "error").at(-1).reason, reason, JSON.stringify(msg));
    };
    await errors({ do: "pair", round: 1, pair: [0, 0] }, "bad pair");
    await errors({ do: "pair", round: 1, pair: [0, 5] }, "bad pair");
    await errors({ do: "pair", round: 1, pair: "0,1" }, "bad pair");
    await errors({ do: "pair", round: 2, pair: [0, 1] }, "wrong round");
    await errors({ do: "field", round: 1, young: 0 }, "wrong phase");
    await errors({ do: "fly" }, "unknown action");
    d.send({ t: "act", do: "pair", round: 1, pair: [0, 1] });
    await d.wait(m => m.do === "pair");
    await errors({ do: "pair", round: 1, pair: [1, 2] }, "already committed");
    assert.equal(s.rooms.stats().rooms, 1, "the match is still running");
  } finally { await s.close(); }
});

test("/stats reports A's clocks, and the defaults are 45 s and 20 s", async () => {
  const s = await server();
  try {
    const j = await (await fetch(`http://127.0.0.1:${s.port}/stats`)).json() as any;
    assert.deepEqual(j.aClockMs, [45000, 20000]);
    assert.deepEqual([BREED_MS, FIELD_MS], [45000, 20000]);
  } finally { await s.close(); }
});
