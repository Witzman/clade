// Variant B's tier 1 client session (web/b/session.ts, workshop issue #65,
// build plan 2026-09-15 piece B2).
//
// Run: node --test tests/b-client.test.ts
//
// The screens themselves are exercised in a real browser by
// bin/browser/b-play.mjs in the private workshop repo. What is asserted here is
// what a browser check cannot assert cheaply: that a stored run resumes to the
// same state and the same screen at every point of a run, that the fight list
// counts each fight exactly once (the run engine re-points `run.fights` rather
// than emptying it, so a naive count double-counts during `breed`), and that
// corrupt or edited storage is refused rather than thrown.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newRun, apply, illegal, hash, eligible, PLAYER, HERD_CAP, LINEUP, STOPS,
} from "../web/b/run.ts";
import type { Decision, Run } from "../web/b/run.ts";
import { LIMITS } from "../web/b/base.ts";
import {
  LIMIT_WORDS, decode, encode, fightsOf, replayStepMs, screenOf,
} from "../web/b/session.ts";
import { rng, int } from "../core/index.ts";

// A legal decision drawn at random: what a player tapping about does.
function pick(run: Run, seed: number): Decision {
  const r = rng((seed ^ (run.log.length * 2654435761)) >>> 0);
  const me = run.exps[PLAYER];
  const shuffle = <T>(xs: T[]) => {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = int(r, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  switch (run.phase) {
    case "founders": return { t: "founders", pick: shuffle([0, 1, 2, 3, 4, 5]).slice(0, 3) };
    case "breed": { const ids = shuffle(me.herd.map(c => c.id)); return { t: "breed", ids: [ids[0], ids[1]] }; }
    case "keep": return { t: "keep", i: int(r, 3) };
    case "release": return { t: "release", ids: shuffle(me.herd.map(c => c.id)).slice(0, me.herd.length - HERD_CAP) };
    case "lineup": return { t: "lineup", ids: shuffle(eligible(run).map(c => c.id)).slice(0, LINEUP) };
    case "answer": return { t: "answer", slot: shuffle([0, 1, 2].filter(s => s < run.lineup!.length && (run.mineLeft & (1 << s))))[0] };
    default: throw new Error("over");
  }
}

test("a stored run resumes to the same state, the same screen and the same fights, at every step", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const run = newRun(seed);
    let seen = 0;
    let guard = 0;
    for (;;) {
      // Where the client would be now, and what it would store.
      const fights = fightsOf(run);
      const screen = screenOf(run, seen);
      assert.equal(screen, seen < fights.length ? "fight" : run.phase, `seed ${seed}: screen`);
      const stored = decode(encode(run, seen));
      assert.ok(stored, `seed ${seed}: a run this client wrote was refused on reload`);
      assert.equal(hash(stored.run), hash(run), `seed ${seed}: reload changed the state`);
      assert.equal(stored.seen, seen);
      assert.equal(screenOf(stored.run, stored.seen), screen, `seed ${seed}: reload changed the screen`);
      const after = fightsOf(stored.run);
      assert.deepEqual(after.map(f => [f.stop, f.crossing, f.mine.id, f.theirs.id, f.rec.result]),
        fights.map(f => [f.stop, f.crossing, f.mine.id, f.theirs.id, f.rec.result]),
        `seed ${seed}: reload changed the fight list`);

      if (seen < fights.length) { seen++; continue; }          // the player watches the replay through
      if (run.phase === "over") break;
      const d = pick(run, seed);
      assert.equal(illegal(run, d), null);
      apply(run, d);
      assert.ok(++guard < 300, "run did not end");
    }
    // Every fight is counted exactly once, in order, and both creatures resolve.
    const all = fightsOf(run);
    assert.equal(seen, all.length, `seed ${seed}: fights shown`);
    assert.deepEqual(all.map(f => f.index), all.map((_, i) => i));
    let last = 0;
    for (const f of all) {
      assert.ok(f.stop >= last && f.stop >= 1 && f.stop <= STOPS, `seed ${seed}: fights out of order`);
      last = f.stop;
      assert.equal(f.rec.mine, f.mine.id);
      assert.equal(f.rec.theirs, f.theirs.id);
      assert.equal(f.crossing, f.stop % 3 === 0);
    }
    const fromStops = run.exps[PLAYER].stops.reduce((n, s) => n + s.fights.length, 0);
    assert.equal(all.length, fromStops, `seed ${seed}: the fight list does not match the stop records`);
  }
});

test("a run mid-stop, with a lineup open, is counted and resumed correctly", () => {
  // The case that double-counts if `run.fights` is read while `phase` is "breed".
  const run = newRun(4242);
  let guard = 0;
  let sawAnswer = false, sawBreedAfterFights = false;
  while (run.phase !== "over") {
    if (run.phase === "answer") sawAnswer = true;
    if (run.phase === "breed" && run.exps[PLAYER].stops.length > 0) {
      sawBreedAfterFights = true;
      const n = run.exps[PLAYER].stops.reduce((k, s) => k + s.fights.length, 0);
      assert.equal(fightsOf(run).length, n, "the live fight array was counted twice during breed");
    }
    apply(run, pick(run, 4242));
    assert.ok(++guard < 300);
  }
  assert.ok(sawAnswer && sawBreedAfterFights, "the run never reached the states this test is about");
});

test("corrupt, edited or foreign storage is refused, never thrown", () => {
  const run = newRun(77);
  while (run.phase !== "over" && run.log.length < 12) apply(run, pick(run, 77));
  const good = encode(run, 0);
  assert.ok(decode(good));

  const bad: (string | null | undefined)[] = [
    null, undefined, "", "not json", "[]", "null", "42", '{"v":2,"seed":77,"log":[],"seen":0}',
    '{"v":1,"seed":-1,"log":[],"seen":0}', '{"v":1,"seed":4294967296,"log":[],"seen":0}',
    '{"v":1,"seed":1.5,"log":[],"seen":0}', '{"v":1,"seed":77,"log":{},"seen":0}',
    '{"v":1,"seed":77,"log":[],"seen":-1}', '{"v":1,"seed":77,"log":[],"seen":1.5}',
    '{"v":1,"seed":77,"log":[],"seen":"0"}', '{"v":1,"seed":77,"log":[{"t":"breed","ids":[0,1]}],"seen":0}',
    '{"v":1,"seed":77,"log":[{"t":"founders","pick":[0,1,99]}],"seen":0}',
    '{"v":1,"seed":77,"log":[{"t":"founders","pick":[0,1]}],"seen":0}',
    '{"v":1,"seed":77,"log":["nonsense"],"seen":0}',
    "x".repeat(20001),
  ];
  for (const t of bad) assert.equal(decode(t), null, `accepted: ${String(t).slice(0, 60)}`);

  // A legal log with `seen` past the fights that exist is refused too.
  const over = JSON.parse(good) as { seen: number };
  over.seen = fightsOf(run).length + 1;
  assert.equal(decode(JSON.stringify(over)), null, "seen past the end was accepted");

  // A truncated log is a legal shorter run, not a refusal: the player left early.
  const short = JSON.parse(good) as { log: Decision[] };
  short.log = short.log.slice(0, 1);
  const back = decode(JSON.stringify({ ...JSON.parse(good), log: short.log, seen: 0 }));
  assert.ok(back, "a prefix of a legal log was refused");
  assert.equal(back.run.log.length, 1);
});

test("the wording the player reads covers every limit, and the timings are sane", () => {
  for (const l of LIMITS) {
    const w = LIMIT_WORDS[l];
    assert.ok(typeof w === "string" && w.length > 0 && !/undefined/.test(w), `no words for the ${l} limit`);
  }
  assert.equal(new Set(Object.values(LIMIT_WORDS)).size, LIMITS.length, "two limits read the same");

  assert.equal(replayStepMs(1), 300);
  assert.equal(replayStepMs(26), 300);
  assert.equal(replayStepMs(40), 200);                       // 8000 / 40
  assert.ok(replayStepMs(200) < 300, "a long replay is not sped up");
  assert.equal(replayStepMs(4000), 60, "the floor of 60 ms per action holds");
});
