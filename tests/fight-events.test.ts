// The replay's fight events against core.fight(). Workshop issue #60 (build
// plan piece X2). Run: node --test tests/fight-events.test.ts
//
// ui/fight-events.ts copies the channel split of core's private `strike` and
// the "who acts this tick" test. This file is the only thing keeping that copy
// honest: over 9000 random fights (the count variant directions §2 used), the
// final hpA, hpB and t must equal core.fight() bit for bit, and so must the hit
// points obtained by folding the events' own damages from full HP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breed, express, fight, fightStart, fightStep, founder, int, rng, stats, type Genome, type Stats,
} from "../core/index.ts";
import { describe, fightEvents, type StrikeEvent } from "../ui/fight-events.ts";

const FIGHTS = 9000;

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const bits = (x: number) => { f64[0] = x; return u64[0]; };

/** Pairs from founders and from children of up to 12 generations of random breeding. */
function pairs(seed: number, n: number): [Stats, Stats][] {
  const r = rng(seed);
  let pool: Genome[] = [];
  for (let i = 0; i < 60; i++) pool.push(founder(r));
  const out: [Stats, Stats][] = [];
  for (let gen = 0; out.length < n; gen = (gen + 1) % 13) {
    if (gen === 0) { pool = []; for (let i = 0; i < 60; i++) pool.push(founder(r)); }
    else pool = pool.map(() => breed(pool[int(r, pool.length)], pool[int(r, pool.length)], r).child);
    for (let k = 0; k < 60 && out.length < n; k++) {
      const a = pool[int(r, pool.length)], b = pool[int(r, pool.length)];
      out.push([stats(express(a)), stats(express(b))]);
    }
  }
  return out;
}

test(`events equal core.fight() bit for bit over ${FIGHTS} random fights`, () => {
  let pass = 0, gassedFights = 0, leads = 0, timeouts = 0, actions = 0, maxActions = 0;
  const fails: string[] = [];
  for (const [i, [A, B]] of pairs(20260915, FIGHTS).entries()) {
    const core = fight(A, B);
    const rec = fightEvents(A, B);

    // Fold the events alone, in order, from full hit points.
    let hpA = A.hp, hpB = B.hp, lastTick = -1, n = 0, snapshotsOk = true;
    for (const e of rec.events) {
      if (e.kind !== "strike") continue;
      if (e.side === "A") { hpB -= e.damage; hpA -= e.riposte; } else { hpA -= e.damage; hpB -= e.riposte; }
      if (bits(hpA) !== bits(e.hpA) || bits(hpB) !== bits(e.hpB) || e.tick < lastTick) snapshotsOk = false;
      lastTick = e.tick; n++;
    }
    const end = rec.events[rec.events.length - 1];
    const ok = snapshotsOk
      && bits(rec.hpA) === bits(core.hpA) && bits(rec.hpB) === bits(core.hpB) && rec.t === core.t
      && bits(hpA) === bits(core.hpA) && bits(hpB) === bits(core.hpB)
      && end.kind === "end" && end.tick === core.t && (core.t >= 700 || lastTick === core.t - 1);
    if (ok) pass++; else if (fails.length < 5) fails.push(`fight ${i}: core ${core.hpA}/${core.hpB}/${core.t} events ${hpA}/${hpB}/${rec.t}`);

    // Coverage of the branches the copy must match: gassed ticks, reach leads, the tick cap.
    if (rec.events[0].kind === "lead") leads++;
    if (end.kind === "end" && end.timeout) timeouts++;
    actions += n; maxActions = Math.max(maxActions, n);
    if (gassedByCore(A, B)) gassedFights++;
  }
  console.log(`fight-events: ${pass}/${FIGHTS} equal bit for bit; fights with a gassed action ${gassedFights}, with a reach lead ${leads}, on the tick cap ${timeouts}; actions mean ${(actions / FIGHTS).toFixed(2)} max ${maxActions}`);
  assert.deepEqual(fails, []);
  assert.equal(pass, FIGHTS);
  assert.ok(gassedFights > 0, "no fight exercised the gassed branch");
  assert.ok(leads > 0, "no fight exercised the reach lead");
});

/** Whether either side is short of stamina on some tick, by core's own stepping. */
function gassedByCore(A: Stats, B: Stats): boolean {
  const f = fightStart(A, B);
  while (!f.done) {
    if (f.stA < A.cost || f.stB < B.cost) return true;
    fightStep(f);
  }
  return false;
}

test("every event describes itself in words, with no gassed flag", () => {
  const seen = new Set<string>();
  for (const [A, B] of pairs(7, 1500)) {
    const rec = fightEvents(A, B);
    for (const e of rec.events) {
      const words = describe(e, { A: "Left", B: "Right" });
      assert.ok(words.length > 0);
      for (const w of words) {
        assert.ok(w.length > 0 && !/undefined|NaN|null/.test(w), `bad text: ${JSON.stringify(w)}`);
        assert.ok(!/gass|tired|stamina/i.test(w), `stamina surfaced: ${w}`);
        seen.add(w.replace(/^(Left|Right)/, "X"));
      }
      assert.ok(!("gassed" in e), "an event carries a gassed flag");
      if (e.kind === "strike") {
        const s = e as StrikeEvent;
        assert.ok(s.damage >= 0 && s.riposte >= 0 && s.softened >= 0);
      }
    }
  }
  console.log(`fight-events: ${seen.size} distinct phrases: ${[...seen].sort().join(" | ")}`);
  // Each channel's clean hit and full counter appear somewhere in 1500 fights.
  for (const w of ["sharp — through", "sharp — stopped by armour", "heavy — missed, too quick", "quick — through"])
    assert.ok(seen.has(w), `never produced: ${w}`);
});
