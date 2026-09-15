// Variant A's tier 1 session (web/a/session.ts): what the browser stores, how a
// stored match resumes, and that the computer's moves are its own. Workshop
// issue #62, build plan 2026-09-15 piece A2.
//
// Run: node --test tests/a-client.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { rng, int } from "../core/index.ts";
import { newMatch, hash, ROUNDS } from "../server/a/rules.ts";
import type { Match } from "../server/a/rules.ts";
import {
  breedRound, fieldRound, encode, decode, screenOf, replayStepMs, thinkMs, computerPair, computerField,
} from "../web/a/session.ts";

// A human who picks at random, from its own stream.
function play(seed: number, onStep?: (m: Match, seen: number) => void): Match {
  const r = rng(seed ^ 0x5a5a5a5a);
  const m = newMatch(seed);
  let seen = 0;
  while (m.phase !== "over") {
    const n = m.herds[0].length;
    const i = int(r, n);
    let j = int(r, n - 1); if (j >= i) j++;
    breedRound(m, [i, j]);
    onStep?.(m, seen);
    fieldRound(m, int(r, 3));
    onStep?.(m, seen);
    seen = m.history.length;
    onStep?.(m, seen);
  }
  return m;
}

test("a stored match resumes at every step with the same state and the same screen", () => {
  let checks = 0, herdLimitSeen = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const m = play(seed, (m, seen) => {
      const back = decode(encode(m, seen));
      assert.ok(back, `seed ${seed} round ${m.round}: decode refused its own encoding`);
      assert.equal(hash(back.match), hash(m));
      assert.equal(back.seen, seen);
      assert.equal(screenOf(back.match, back.seen), screenOf(m, seen));
      if (m.released[0].length || m.released[1].length) herdLimitSeen++;
      checks++;
    });
    assert.ok(m.result, "the match ends with a result");
    assert.ok(m.history.length <= ROUNDS);
  }
  console.log(`a-client: ${checks} resumes checked over 40 matches; steps showing a herd-limit release ${herdLimitSeen}`);
});

test("the screen follows the phase, and a fight not yet shown comes first", () => {
  const m = newMatch(7);
  assert.equal(screenOf(m, 0), "breed");
  breedRound(m, [0, 1]);
  assert.equal(screenOf(m, 0), "field");
  fieldRound(m, 0);
  assert.equal(screenOf(m, 0), "fight");
  assert.equal(screenOf(m, 1), m.phase === "over" ? "over" : "breed");
});

test("storage that is absent, corrupt, edited or illegal is refused, never thrown", () => {
  const m = newMatch(99);
  breedRound(m, [0, 1]);
  fieldRound(m, 2);
  breedRound(m, [2, 3]);
  const good = JSON.parse(encode(m, 1));
  assert.ok(decode(JSON.stringify(good)));
  const bad: unknown[] = [
    null, undefined, "", "{", "[]", "42", "null",
    { ...good, v: 2 },
    { ...good, seed: -1 }, { ...good, seed: 1.5 }, { ...good, seed: 2 ** 32 },
    { ...good, seen: 2 }, { ...good, seen: -1 }, { ...good, seen: "1" },
    { ...good, decisions: "x" },
    { ...good, decisions: [{ pairs: [[0, 0], good.decisions[0].pairs[1]], fields: [0, 0] }] },
    { ...good, decisions: [{ pairs: [[0, 1], [0, 1]] }, good.decisions[1]] },
    { ...good, decisions: [{ ...good.decisions[0], fields: [3, good.decisions[0].fields[1]] }, good.decisions[1]] },
  ];
  // The computer's own move, edited: another pair and another fighter.
  const cp = good.decisions[0].pairs[1];
  bad.push({ ...good, decisions: [{ ...good.decisions[0], pairs: [good.decisions[0].pairs[0], cp[0] === 0 && cp[1] === 1 ? [0, 2] : [0, 1]] }, good.decisions[1]] });
  const cf = good.decisions[0].fields[1];
  bad.push({ ...good, decisions: [{ ...good.decisions[0], fields: [good.decisions[0].fields[0], (cf + 1) % 3] }, good.decisions[1]] });
  for (const b of bad) {
    const text = typeof b === "string" || b == null ? (b as string | null | undefined) : JSON.stringify(b);
    assert.equal(decode(text), null, `accepted: ${String(text).slice(0, 120)}`);
  }
});

test("the computer's moves depend only on the match, so a resume cannot change them", () => {
  const a = newMatch(12345), b = newMatch(12345);
  for (let k = 0; k < 3 && a.phase !== "over"; k++) {
    assert.deepEqual(computerPair(a), computerPair(b));
    breedRound(a, [0, 1]); breedRound(b, [0, 1]);
    assert.equal(computerField(a), computerField(b));
    fieldRound(a, 1); fieldRound(b, 1);
  }
  assert.equal(hash(a), hash(b));
});

test("replay pace and thinking time stay inside their bounds", () => {
  for (let n = 0; n <= 700; n++) {
    const ms = replayStepMs(n);
    assert.ok(ms >= 60 && ms <= 300);
    if (n <= 26) assert.equal(ms, 300);
    else assert.ok(n * ms <= 8000 || ms === 60);
  }
  assert.equal(thinkMs(0), 300);
  assert.equal(thinkMs(1), 1500);
  assert.equal(thinkMs(-5), 300);
  assert.equal(thinkMs(9), 1500);
});
