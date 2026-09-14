// The server skeleton, exercised in process. Workshop issue #25.
//
//   node --test tests/server.test.ts
//
// Real sockets (Node 22's global WebSocket) against a real listening server on
// an ephemeral port. Nothing is mocked: the point is what a client can and
// cannot receive.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/main.ts";
import type { ServerOptions } from "../server/main.ts";
import { replay, autoDecisions } from "../server/testroom/run.ts";
import { ROUNDS, matchHash } from "../server/testroom/room.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const quiet = { log: () => {} };

async function server(o: Partial<ServerOptions> = {}) {
  return startServer({ port: 0, webRoot: join(import.meta.dirname, "..", "web"), ...quiet, ...o });
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
        if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(frames).slice(0, 600)}`);
        await new Promise<void>(r => { wake = r; setTimeout(r, 20); });
      }
    },
  };
  return new Promise((ok, fail) => { ws.onopen = () => ok(c); ws.onerror = () => fail(new Error("ws error")); });
}

const run = (runSeed: number) => ({ runSeed, decisions: autoDecisions(), stateHash: replay(runSeed, autoDecisions()).hash });

async function player(port: number, id: string, vs: "person" | "computer", seed = 1) {
  const c = await client(port);
  c.send({ t: "hello", v: 1, id, name: id, variant: "test" });
  await c.wait(m => m.t === "welcome");
  c.send({ t: "enter", ...run(seed) });
  await c.wait(m => m.t === "accepted" && m.do === "enter");
  c.send({ t: "queue", level: 0, vs });
  return c;
}

// ---------------------------------------------------------------- http

test("/healthz is byte-identical: 200, text/plain, body exactly ok", async () => {
  const s = await server();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/plain");
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0x6f, 0x6b]);
  } finally { await s.close(); }
});

test("static serving is generic over the web root, and contained in it", async () => {
  const base = mkdtempSync(join(tmpdir(), "clade-static-"));
  const root = join(base, "web");
  mkdirSync(join(root, "render-test", "deep"), { recursive: true });
  writeFileSync(join(base, "secret.txt"), "SECRET");
  writeFileSync(join(root, "index.html"), "<p>home");
  writeFileSync(join(root, "page.html"), "<p>page");
  writeFileSync(join(root, "render-test", "index.html"), "<p>render");
  writeFileSync(join(root, "render-test", "main.js"), "export {}");
  writeFileSync(join(root, "render-test", "deep", "s.css"), "a{}");
  writeFileSync(join(root, "render-test", "deep", "p.png"), "png");
  writeFileSync(join(root, "render-test", "deep", "d.json"), "{}");
  const s = await server({ webRoot: root });
  const get = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { redirect: "manual", ...init });
  try {
    const type = async (p: string) => { const r = await get(p); assert.equal(r.status, 200, p); return r.headers.get("content-type"); };
    assert.equal(await type("/"), "text/html; charset=utf-8");
    assert.equal(await type("/render-test/"), "text/html; charset=utf-8");
    assert.equal(await type("/render-test/main.js"), "text/javascript; charset=utf-8");
    assert.equal(await type("/render-test/deep/s.css"), "text/css; charset=utf-8");
    assert.equal(await type("/render-test/deep/p.png"), "image/png");
    assert.equal(await type("/render-test/deep/d.json"), "application/json");
    const redirect = await get("/render-test");
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/render-test/");
    assert.equal(await (await get("/page")).text(), "<p>page");
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/render-test/..%2f..%2fsecret.txt", "/nope"]) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(await r.text(), /SECRET/);
    }
    assert.equal((await get("/", { method: "POST" })).status, 405);
  } finally { await s.close(); }
});

test("static files carry cache headers and validators, and answer 304", async () => {
  const base = mkdtempSync(join(tmpdir(), "clade-cache-"));
  const root = join(base, "web");
  mkdirSync(join(root, "assets", "materials"), { recursive: true });
  mkdirSync(join(root, "render-test"), { recursive: true });
  writeFileSync(join(root, "render-test", "index.html"), "<p>render");
  writeFileSync(join(root, "render-test", "main.js"), "export {}");
  writeFileSync(join(root, "assets", "materials", "fur.png"), "png");
  writeFileSync(join(root, "data.json"), "{}");
  const s = await server({ webRoot: root });
  const get = (p: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${s.port}${p}`, { headers, redirect: "manual" });
  try {
    const cc = async (p: string) => (await get(p)).headers.get("cache-control");
    assert.equal(await cc("/render-test/"), "no-cache");
    assert.equal(await cc("/render-test/main.js"), "no-cache");
    assert.equal(await cc("/assets/materials/fur.png"), "public, max-age=3600");
    assert.equal(await cc("/data.json"), "public, max-age=300");

    for (const p of ["/render-test/", "/render-test/main.js", "/assets/materials/fur.png"]) {
      const first = await get(p);
      const etag = first.headers.get("etag")!;
      const lm = first.headers.get("last-modified")!;
      assert.match(etag, /^"[A-Za-z0-9_-]{22}"$/, p);
      assert.ok(lm, p);
      const again = await get(p, { "if-none-match": etag });
      assert.equal(again.status, 304, p);
      assert.equal(await again.text(), "");
      assert.equal(again.headers.get("etag"), etag);
      assert.equal((await get(p, { "if-modified-since": lm })).status, 304, p);
      assert.equal((await get(p, { "if-none-match": '"stale"' })).status, 200, p);
    }
    // /healthz is not a static file and stays exactly as it was: no validators.
    const h = await get("/healthz", { "if-none-match": "*" });
    assert.equal(h.status, 200);
    assert.equal(h.headers.get("etag"), null);
    assert.equal(await h.text(), "ok");
  } finally { await s.close(); }
});

test("the real web/ tree serves the placeholders and the test room", async () => {
  const s = await server();
  try {
    for (const p of ["/", "/a/", "/b/", "/c/", "/test-room/"]) {
      assert.equal((await fetch(`http://127.0.0.1:${s.port}${p}`)).status, 200, p);
    }
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- matches

// The frame-level guarantee: before a round's reveal, nothing a side has
// received carries the other side's pick. The one frame allowed to carry a
// pick is the side's own commit acknowledgement, and there is exactly one per
// round: the server addressing the other side's acknowledgement here as well
// would make it two.
function assertNoLeak(frames: any[], raw: string[], round: number) {
  let ownAcks = 0;
  for (let i = 0; i < frames.length; i++) {
    const m = frames[i];
    if (m.t === "accepted" && m.do === "reveal" && m.round === round) break;
    if (m.round !== round) continue;
    assert.equal(m.picks, undefined, "picks before reveal");
    if (m.do === "commit") { ownAcks++; continue; }
    if (m.do === "opponentCommitted") assert.deepEqual(Object.keys(m).sort(), ["do", "round", "t"]);
    assert.doesNotMatch(raw[i], /"pick"|"picks"|"myCommit":\d/, `leaking frame: ${raw[i]}`);
  }
  assert.ok(ownAcks <= 1, `round ${round}: ${ownAcks} commit frames reached one side`);
}

test("two people play a full match; neither receives the other's commit before the reveal", async () => {
  const s = await server();
  try {
    const a = await player(s.port, "alice-0001", "person", 11);
    const b = await player(s.port, "bobby-0002", "person", 22);
    const ma = await a.wait(m => m.t === "matched");
    const mb = await b.wait(m => m.t === "matched");
    assert.equal(ma.seed, mb.seed);
    assert.equal(ma.room, mb.room);
    assert.notEqual(ma.side, mb.side);

    for (let r = 0; r < ROUNDS; r++) {
      await a.wait(m => m.do === "round" && m.round === r);
      await b.wait(m => m.do === "round" && m.round === r);
      // Alternate who commits first, so both directions are inspected.
      const [first, second] = r % 2 === 0 ? [a, b] : [b, a];
      first.send({ t: "act", do: "commit", round: r, pick: r % 4 });
      await second.wait(m => m.do === "opponentCommitted" && m.round === r);
      await sleep(30);
      assertNoLeak(second.frames, second.raw, r);
      assert.equal(second.frames.some(m => m.do === "reveal" && m.round === r), false);
      second.send({ t: "act", do: "commit", round: r, pick: (r + 1) % 4 });
      const ra = await a.wait(m => m.do === "reveal" && m.round === r);
      const rb = await b.wait(m => m.do === "reveal" && m.round === r);
      assert.deepEqual(ra, rb);
      assertNoLeak(second.frames, second.raw, r);
      assertNoLeak(first.frames, first.raw, r);
    }
    const [resA, resB] = await Promise.all([a.wait(m => m.t === "result"), b.wait(m => m.t === "result")]);
    assert.deepEqual(resA, resB);
    // The result hash is recomputable from public frames.
    const history = a.frames.filter(m => m.do === "reveal").map(m => ({ picks: m.picks, hp: m.hp }));
    assert.equal(matchHash(ma.seed, history), resA.hash);
    assert.equal(s.rooms.stats().rooms, 0);
  } finally { await s.close(); }
});

test("the computer is seated through the protocol and never receives a pending commit", async () => {
  const s = await server({ keepComputerFrames: true, computerThinkMs: [60, 120] });
  try {
    const h = await player(s.port, "human-0003", "computer", 33);
    const mh = await h.wait(m => m.t === "matched");
    for (let r = 0; r < ROUNDS; r++) {
      await h.wait(m => m.do === "round" && m.round === r);
      // The human commits at once, well before the computer thinks: the seat
      // has every opportunity to see the pick if anything leaked it.
      h.send({ t: "act", do: "commit", round: r, pick: 3 - r });
      await h.wait(m => m.do === "reveal" && m.round === r);
    }
    const res = await h.wait(m => m.t === "result");
    await sleep(20);
    const seat = s.rooms.seats[0];
    const frames = seat.frames.map(t => JSON.parse(t));
    assert.equal(frames[0].t, "welcome");
    assert.ok(frames.some(m => m.t === "matched" && m.side === 1 - mh.side));
    for (let r = 0; r < ROUNDS; r++) assertNoLeak(frames, seat.frames, r);
    assert.ok(frames.some(m => m.do === "opponentCommitted"));
    assert.equal(frames.find(m => m.t === "result")?.hash, res.hash);
  } finally { await s.close(); }
});

test("the clock reveals with server-drawn picks when nobody commits", async () => {
  const s = await server({ turnMs: 80 });
  try {
    const a = await player(s.port, "slow-a-0004", "person");
    const b = await player(s.port, "slow-b-0005", "person");
    const res = await a.wait(m => m.t === "result", 3000);
    const reveals = a.frames.filter(m => m.do === "reveal");
    assert.equal(reveals.length, ROUNDS);
    for (const r of reveals) assert.deepEqual(r.timedOut, [true, true]);
    assert.equal((await b.wait(m => m.t === "result")).hash, res.hash);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- enter

test("enter replays the run: a forged hash is refused and logged with LOG_DESYNC", async () => {
  const lines: string[] = [];
  const s = await server({ logDesync: true, log: l => lines.push(l) });
  try {
    const c = await client(s.port);
    c.send({ t: "hello", v: 1, id: "forger-0006", name: "f", variant: "test" });
    await c.wait(m => m.t === "welcome");
    c.send({ t: "queue", level: 0, vs: "computer" });
    assert.equal((await c.wait(m => m.t === "error")).reason, "enter first");
    c.send({ t: "enter", ...run(5), stateHash: "deadbeef" });
    assert.ok(await c.wait(m => m.reason === "desync"));
    assert.ok(lines.some(l => l.startsWith("DESYNC id=forger-0006 runSeed=5 decisions=3 client=deadbeef") && l.includes("ua=")),
              lines.join("\n"));
    c.send({ t: "enter", runSeed: 5, decisions: [[0, 9]], stateHash: "x" });
    assert.ok(await c.wait(m => m.reason === "bad run"));
    c.send({ t: "enter", ...run(5) });
    const ok = await c.wait(m => m.do === "enter");
    assert.equal(ok.hash, replay(5, autoDecisions()).hash);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- limits

test("a variant that is an Object.prototype key is refused, and the server keeps serving", async () => {
  const s = await server();
  try {
    for (const variant of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "nope"]) {
      const c = await client(s.port);
      c.send({ t: "hello", v: 1, id: "qa0123456789", name: "qa", variant });
      const m = await c.wait(f => f.t === "error" || f.t === "welcome");
      assert.deepEqual([variant, m.t, m.reason], [variant, "error", "unknown variant"]);
      c.ws.close();
    }
    // A non-string variant must not be coerced into a key either.
    const weird = await client(s.port);
    weird.send({ t: "hello", v: 1, id: "qa0123456789", name: "qa", variant: { toString: () => "test" } });
    assert.equal((await weird.wait(f => f.t === "error")).reason, "unknown variant");
    weird.ws.close();

    // Still serving: a real match runs to its result on the same process.
    const a = await player(s.port, "after-a-0001", "person");
    const b = await player(s.port, "after-b-0002", "person");
    await Promise.all([a.wait(m => m.t === "matched"), b.wait(m => m.t === "matched")]);
    for (let r = 0; r < ROUNDS; r++) {
      await Promise.all([a.wait(m => m.do === "round" && m.round === r), b.wait(m => m.do === "round" && m.round === r)]);
      a.send({ t: "act", do: "commit", round: r, pick: 1 });
      b.send({ t: "act", do: "commit", round: r, pick: 2 });
      await Promise.all([a.wait(m => m.do === "reveal" && m.round === r), b.wait(m => m.do === "reveal" && m.round === r)]);
    }
    const [resA, resB] = await Promise.all([a.wait(m => m.t === "result"), b.wait(m => m.t === "result")]);
    assert.deepEqual(resA, resB);
  } finally { await s.close(); }
});

test("MAX_WS refuses the socket beyond the cap with {t:\"full\"}", async () => {
  const s = await server({ maxWs: 2 });
  try {
    await client(s.port);
    await client(s.port);
    const third = await client(s.port);
    assert.deepEqual(await third.wait(m => m.t === "full"), { t: "full" });
    assert.equal((await third.closed).code, 1013);
  } finally { await s.close(); }
});

// The cap works (above). This is about being able to CHECK that it works on a
// deployment without exhausting it: on the POC host one WebSocket holds one
// whole Apache prefork worker, shared with unrelated sites, so "open sockets
// until one is refused" is the very thing the cap exists to prevent anyone
// doing (#44). The same applies to every other knob: LOG_DESYNC decides
// whether a determinism measurement is kept or discarded, and its value was
// readable only from the container's environment over SSH (#37).
test("/stats reports the configured ceiling, the other options, and a refusal count", async () => {
  const s = await server({ maxWs: 2, graceMs: 1234, turnMs: 5678, logDesync: true });
  const stats = async () => (await fetch(`http://127.0.0.1:${s.port}/stats`)).json() as Promise<any>;
  try {
    const before = await stats();
    assert.equal(before.maxWs, 2, "the ceiling the process is running with");
    assert.equal(before.graceMs, 1234);
    assert.equal(before.turnMs, 5678);
    assert.equal(before.logDesync, true);
    assert.equal(before.refused, 0);

    await client(s.port);
    await client(s.port);
    const third = await client(s.port);
    await third.wait(m => m.t === "full");
    await third.closed;

    const after = await stats();
    assert.equal(after.refused, 1, "a refused socket is counted, not only logged");
    assert.equal(after.maxWs, 2);
  } finally { await s.close(); }
});

// The default is off, so a suite that only ever ran with it on would not
// notice it being reported as a constant.
test("/stats reports logDesync false when it is off", async () => {
  const s = await server();
  try {
    const j = await (await fetch(`http://127.0.0.1:${s.port}/stats`)).json() as any;
    assert.equal(j.logDesync, false);
    assert.equal(j.maxWs, 40, "startServer's own default, the same 40 the entrypoint and the Dockerfile use");
  } finally { await s.close(); }
});

test("ws ping keeps a live client connected", async () => {
  const s = await server({ pingMs: 30 });
  try {
    const c = await client(s.port);
    await sleep(200);
    assert.equal(c.ws.readyState, WebSocket.OPEN);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- reconnect

test("reconnect by identity within the grace period resumes the same match, same options", async () => {
  const s = await server();
  try {
    const a = await player(s.port, "rejoin-a-0007", "person", 7);
    const b = await player(s.port, "rejoin-b-0008", "person", 8);
    const first = await a.wait(m => m.do === "round" && m.round === 0);
    await b.wait(m => m.do === "round" && m.round === 0);
    b.send({ t: "act", do: "commit", round: 0, pick: 1 });
    a.ws.close();
    await a.closed;
    await sleep(30);

    const a2 = await client(s.port);
    a2.send({ t: "hello", v: 1, id: "rejoin-a-0007", name: "a", variant: "test" });
    const w = await a2.wait(m => m.t === "welcome");
    const matched = await a2.wait(m => m.t === "matched");
    assert.equal(w.room, matched.room);
    a2.send({ t: "act", do: "sync" });
    const sync = await a2.wait(m => m.do === "sync");
    assert.deepEqual(sync.options, first.options, "a reconnect must not re-roll the options");
    assert.equal(sync.myCommit, null);
    assert.equal(sync.opponentCommitted, true);
    assert.doesNotMatch(a2.raw.join("\n"), /"pick"/);
    a2.send({ t: "act", do: "commit", round: 0, pick: 2 });
    const rev = await a2.wait(m => m.do === "reveal");
    assert.equal(rev.picks[matched.side], 2);
    assert.equal(rev.picks[1 - matched.side], 1);
  } finally { await s.close(); }
});

test("a second socket with the same identity replaces the first", async () => {
  const s = await server();
  try {
    const one = await client(s.port);
    one.send({ t: "hello", v: 1, id: "twotabs-0009", name: "t", variant: "test" });
    await one.wait(m => m.t === "welcome");
    const two = await client(s.port);
    two.send({ t: "hello", v: 1, id: "twotabs-0009", name: "t", variant: "test" });
    await two.wait(m => m.t === "welcome");
    assert.ok(await one.wait(m => m.reason === "replaced"));
    assert.equal((await one.closed).code, 4000);
  } finally { await s.close(); }
});

test("after the grace period the match is gone, and welcome says so", async () => {
  const s = await server({ graceMs: 80 });
  try {
    const h = await player(s.port, "leaver-0010", "computer");
    await h.wait(m => m.t === "matched");
    h.ws.close();
    await h.closed;
    await sleep(250);
    const { rooms, sessions, waiting } = s.rooms.stats();
    assert.deepEqual({ rooms, sessions, waiting }, { rooms: 0, sessions: 0, waiting: 0 });
    const again = await client(s.port);
    again.send({ t: "hello", v: 1, id: "leaver-0010", name: "l", variant: "test" });
    assert.equal((await again.wait(m => m.t === "welcome")).room, null);
  } finally { await s.close(); }
});

test("a restart tells clients, closes 1012, and the new server answers room: null", async () => {
  const s = await server();
  const port = s.port;
  const h = await player(port, "restart-0011", "computer");
  const matched = await h.wait(m => m.t === "matched");
  assert.ok(matched.room);
  await s.close();
  assert.ok(h.frames.some(m => m.t === "error" && m.reason === "restarting"));
  assert.equal((await h.closed).code, 1012);

  const s2 = await server({ port } as ServerOptions);
  try {
    const c = await client(port);
    c.send({ t: "hello", v: 1, id: "restart-0011", name: "r", variant: "test" });
    assert.equal((await c.wait(m => m.t === "welcome")).room, null);
  } finally { await s2.close(); }
});

// ------------------------------------------------- a seat nobody is sitting in

// #36. The client rule that ends the reconnect war is "never reconnect on a
// 4xxx close". It can only be that simple if the server keeps three promises,
// which is what this asserts: the code is in the application range, the reason
// arrives *before* the close so the client can name it, and the socket that
// did the replacing is the one that now owns the session.
test("the replaced socket is told why before it is closed, with a 4xxx code", async () => {
  const s = await server();
  try {
    const one = await client(s.port);
    one.send({ t: "hello", v: 1, id: "twotabs-0012", name: "t", variant: "test" });
    await one.wait(m => m.t === "welcome");
    const two = await client(s.port);
    two.send({ t: "hello", v: 1, id: "twotabs-0012", name: "t", variant: "test" });
    await two.wait(m => m.t === "welcome");

    const code = (await one.closed).code;
    assert.ok(code >= 4000 && code <= 4999, `close code ${code} must be in the application range`);
    assert.deepEqual(JSON.parse(one.raw[one.raw.length - 1]), { t: "error", reason: "replaced" },
                     "the reason must be the last frame before the close, or the client cannot name it");

    // The newest socket owns the session; the replaced one owns nothing.
    two.send({ t: "act", do: "sync" });
    assert.equal((await two.wait(m => m.t === "error")).reason, "not in a match");
    assert.equal(s.rooms.stats().sessions, 1);
  } finally { await s.close(); }
});

// #38. Everything below is the seat interface: the protocol had no
// server->client message for an empty seat, so a player was told nothing and
// could lose a match to one.
test("a dropped opponent is announced at once, and the clock stops with them", async () => {
  const s = await server({ turnMs: 1000, graceMs: 8000 });
  try {
    const a = await player(s.port, "gone-a-0013", "person", 13);
    const b = await player(s.port, "gone-b-0014", "person", 14);
    await a.wait(m => m.t === "matched");
    const round = await a.wait(m => m.do === "round" && m.round === 0);
    assert.ok(round.deadline > Date.now(), "the clock is running before the drop");

    const t0 = Date.now();
    b.ws.close();
    const gone = await a.wait(m => m.do === "opponentGone", 2000);
    assert.ok(Date.now() - t0 < 1000, `told after ${Date.now() - t0} ms — that is not promptly`);
    assert.equal(gone.grace, 8000);
    assert.equal(gone.deadline, null, "the clock must stop while the seat is empty");

    // Well past the turn clock, and no round has been resolved against the
    // player who is still here.
    await sleep(2500);
    assert.equal(a.frames.filter(m => m.do === "reveal").length, 0,
                 "a round resolved while the opponent's seat was empty");
    assert.equal(a.frames.some(m => m.t === "result"), false);

    // Back inside the grace period: the clock starts again with what was left.
    const b2 = await client(s.port);
    b2.send({ t: "hello", v: 1, id: "gone-b-0014", name: "b", variant: "test" });
    await b2.wait(m => m.t === "matched");
    const back = await a.wait(m => m.do === "opponentBack", 2000);
    assert.ok(back.deadline > Date.now(), "the clock must start again when the seat is filled");
    assert.ok(back.deadline - Date.now() <= 1000, "and with what was left on it, not a fresh turn");
    await a.wait(m => m.do === "reveal" && m.round === 0, 3000);
  } finally { await s.close(); }
});

test("when the grace period expires the match ends and the player still there wins", async () => {
  const s = await server({ turnMs: 1000, graceMs: 300 });
  try {
    const a = await player(s.port, "walk-a-0015", "person", 15);
    const b = await player(s.port, "walk-b-0016", "person", 16);
    const ma = await a.wait(m => m.t === "matched");
    await a.wait(m => m.do === "round" && m.round === 0);
    b.ws.close();
    await a.wait(m => m.do === "opponentGone", 2000);
    const left = await a.wait(m => m.do === "opponentLeft", 3000);
    assert.equal(left.deadline, null);
    const res = await a.wait(m => m.t === "result", 2000);
    assert.equal(res.winner, ma.side, "the player who is still there wins the seat that emptied");
    assert.equal(res.reason, "opponentLeft");
    // The score is what was actually played, not an invented sweep.
    assert.deepEqual(res.wins, [0, 0]);
    assert.equal(matchHash(ma.seed, []), res.hash);
    await sleep(50);
    assert.equal(s.rooms.stats().rooms, 0);
  } finally { await s.close(); }
});

test("an explicit leave ends the match for the opponent immediately, not at the clock", async () => {
  const s = await server({ turnMs: 20000, graceMs: 60000 });
  try {
    const a = await player(s.port, "quit-a-0017", "person", 17);
    const b = await player(s.port, "quit-b-0018", "person", 18);
    const ma = await a.wait(m => m.t === "matched");
    await a.wait(m => m.do === "round" && m.round === 0);
    const t0 = Date.now();
    b.send({ t: "leave" });
    await a.wait(m => m.do === "opponentLeft", 2000);
    const res = await a.wait(m => m.t === "result", 2000);
    assert.ok(Date.now() - t0 < 2000, "the remaining player must not sit out the clock");
    assert.equal(res.winner, ma.side);
    assert.equal(res.reason, "opponentLeft");
    // The one who left is told `left`, and is not sent the room's result.
    assert.equal((await b.wait(m => m.do === "left")).t, "accepted");
    assert.equal(b.frames.some(m => m.t === "result"), false);
    await sleep(50);
    assert.equal(s.rooms.stats().rooms, 0);
  } finally { await s.close(); }
});

test("a second tab is not a disconnect: the opponent is told nothing", async () => {
  const s = await server({ turnMs: 20000, graceMs: 60000 });
  try {
    const a = await player(s.port, "tabs-a-0019", "person", 19);
    const b = await player(s.port, "tabs-b-0020", "person", 20);
    await a.wait(m => m.t === "matched");
    await a.wait(m => m.do === "round" && m.round === 0);
    // B opens the game again in the same browser: the newest socket wins, but
    // the seat was never empty, so A's clock and A's screen must not move.
    const b2 = await client(s.port);
    b2.send({ t: "hello", v: 1, id: "tabs-b-0020", name: "b", variant: "test" });
    await b2.wait(m => m.t === "matched");
    assert.equal((await b.closed).code, 4000);
    await sleep(200);
    assert.equal(a.frames.some(m => m.do === "opponentGone" || m.do === "opponentBack"
                                 || m.do === "opponentLeft"), false);
    // And the match is still playable from the tab that took over.
    b2.send({ t: "act", do: "sync" });
    assert.equal((await b2.wait(m => m.do === "sync")).round, 0);
  } finally { await s.close(); }
});
