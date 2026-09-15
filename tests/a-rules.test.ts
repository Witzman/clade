// Variant A's rules and computer (server/a/), and the core scorer and
// divergence they read. Workshop issue #59, build plan 2026-09-15 piece A1.
//
// Run: node --test tests/a-rules.test.ts
//
// The snowball check prints P(round-1 winner wins the match) over 200
// computer-against-computer matches. The reference is the measured mirror-deal
// figure, 66.0 % (95 % CI 61.4-70.6) over 400 matches; with independent 50/50
// rounds it would be 42/64 = 65.6 %. Above 75 % the port has drifted from the
// reference and this test fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../core/index.ts";
import {
  newMatch, view, applyBreed, applyField, replay, decisions, hash, streamSeed, release,
  STREAM, FOUNDERS, HERD_LIMIT, ROUNDS, TO_WIN, LITTER,
} from "../server/a/rules.ts";
import type { Match, Side, Creature } from "../server/a/rules.ts";
import { choosePair, chooseField, expArith, DEFAULT_COMPUTER } from "../server/a/computer.ts";

const cpuSeed = (seed: number, s: Side) => streamSeed(seed, STREAM.computer, 0, s);

// A computer-against-computer match, checking invariants after every step.
function play(seed: number, check = true): Match {
  const m = newMatch(seed);
  while (m.phase !== "over") {
    const v = view(m);
    applyBreed(m, [choosePair(v, 0, cpuSeed(seed, 0)), choosePair(v, 1, cpuSeed(seed, 1))]);
    const w = view(m);
    applyField(m, [chooseField(w, 0, cpuSeed(seed, 0)), chooseField(w, 1, cpuSeed(seed, 1))]);
    if (check) {
      for (const h of m.herds) {
        assert.ok(h.length >= FOUNDERS, `herd below ${FOUNDERS}: ${h.length}`);
        assert.equal(h.filter(c => c.founder).length, FOUNDERS, "a founder was lost");
        if (m.phase === "breed") assert.ok(h.length <= HERD_LIMIT, `herd above the limit before breeding: ${h.length}`);
      }
      assert.ok(m.round <= ROUNDS);
      assert.equal(m.wins[0] + m.wins[1], m.history.filter(r => r.winner !== null).length);
    }
  }
  return m;
}

// The #21 breeder run for `gens` generations (the shape of `simulate` in
// tests/determinism.test.ts, without its hashing): 6 demes of 20.
function population(seed: number, gens: number): C.Genome[] {
  const r = C.rng(seed);
  const duel = (a: C.Genome, b: C.Genome) => C.fightResult(C.fight(C.stats(C.express(a)), C.stats(C.express(b))));
  let demes: C.Genome[][] = [];
  for (let d = 0; d < 6; d++) {
    const z = [0, 1, 2, 3].map(() => C.founder(r));
    while (z.length < 20) z.push(C.breed(z[C.int(r, z.length)], z[C.int(r, z.length)], r).child);
    demes.push(z);
  }
  for (let g = 1; g <= gens; g++) {
    const champs: C.Genome[] = [];
    demes = demes.map(pool => {
      const wins = pool.map((c, i) => {
        let w = 0;
        for (let k = 0; k < 7; k++) { let j = C.int(r, pool.length - 1); if (j >= i) j++; if (duel(c, pool[j]) > 0) w++; }
        return w;
      });
      const order = pool.map((_, i) => i).sort((a, b) => wins[b] - wins[a] || a - b);
      const winners = order.slice(0, 10).map(i => pool[i]);
      champs.push(winners[0]);
      const keep = winners.slice(0, 7);
      const kids: C.Genome[] = [];
      while (keep.length + kids.length < 20) {
        let a = C.int(r, 10), b = C.int(r, 9); if (b >= a) b++;
        if (C.unit(r) < 0.4) {
          let best = -1;
          for (let k = 0; k < 6; k++) {
            const x = C.int(r, 10); let y = C.int(r, 9); if (y >= x) y++;
            const dd = C.divergence(winners[x], winners[y]);
            if (dd > best) { best = dd; a = x; b = y; }
          }
        }
        kids.push(C.breed(winners[a], winners[b], r).child);
      }
      return keep.concat(kids);
    });
    for (let d = 0; d < 6; d++) for (let k = 0; k < 2; k++) {
      const e = C.int(r, 6); if (e === d) continue;
      const res = duel(champs[d], champs[e]);
      if (res === 0) continue;
      const [src, dst] = res > 0 ? [d, e] : [e, d];
      demes[dst][C.int(r, 20)] = demes[src][C.int(r, 20)].slice();
    }
  }
  return demes.flat();
}

test("score predicts the fight() winner in at least 90% of 2000 generation-10 pairs", () => {
  let right = 0;
  const N = 2000;
  const pops = [20260913, 7, 99].map(s => population(s, 10));
  const r = C.rng(59);
  for (let n = 0; n < N; n++) {
    const pop = pops[n % pops.length];
    const i = C.int(r, pop.length); let j = C.int(r, pop.length - 1); if (j >= i) j++;
    const a = C.stats(C.express(pop[i])), b = C.stats(C.express(pop[j]));
    const predicted = C.score(a, b) > C.score(b, a);
    const won = C.fightResult(C.fight(a, b)) > 0;
    if (predicted === won) right++;
  }
  console.log(`score reads the matchup correctly in ${(100 * right / N).toFixed(1)}% of ${N} generation-10 pairs (reference 96%)`);
  assert.ok(right / N >= 0.9, `score accuracy ${right / N}`);
});

test("divergence is the determinism test's distance, symmetric, zero on itself", () => {
  const distance = (a: C.Genome, b: C.Genome) => { // verbatim from tests/determinism.test.ts
    let d = 0, mm = 0;
    for (let l = 0; l < C.NL; l++) {
      if (C.form(a, l, 0) !== C.form(b, l, 0)) mm++;
      for (let s = 0; s < 2; s++) for (let x = 0; x < C.NA; x++)
        d += Math.abs(((a[(l * 2 + s) * 9 + 4 + x] << 24) >> 24) - ((b[(l * 2 + s) * 9 + 4 + x] << 24) >> 24));
    }
    return d / (C.NL * 2 * C.NA) + 42 * mm / C.NL;
  };
  const r = C.rng(5);
  const gs = Array.from({ length: 12 }, () => C.founder(r));
  for (let i = 0; i < 30; i++) gs.push(C.breed(gs[C.int(r, gs.length)], gs[C.int(r, gs.length)], r).child);
  for (const a of gs) {
    assert.equal(C.divergence(a, a), 0);
    for (const b of gs) {
      assert.equal(C.divergence(a, b), distance(a, b));
      assert.equal(C.divergence(a, b), C.divergence(b, a));
    }
  }
});

test("the deal is a mirror: both herds hold the same five founders", () => {
  for (const seed of [1, 2, 3, 20260915]) {
    const m = newMatch(seed);
    assert.equal(m.herds[0].length, FOUNDERS);
    for (let i = 0; i < FOUNDERS; i++) {
      assert.deepEqual(m.herds[0][i].g, m.herds[1][i].g);
      assert.notEqual(m.herds[0][i].g, m.herds[1][i].g, "the two sides share a genome buffer");
    }
    assert.notDeepEqual(newMatch(seed + 1).herds[0][0].g, m.herds[0][0].g);
  }
});

test("a litter depends on (seed, round, side) only: the other side's choice cannot reroll it", () => {
  const a = applyBreed(newMatch(11), [[0, 1], [2, 3]]);
  const b = applyBreed(newMatch(11), [[3, 4], [2, 3]]);
  const c = applyBreed(newMatch(11), [[0, 1], [2, 3]]);
  assert.equal(a.litters![0].length, LITTER);
  assert.deepEqual(a.litters![1].map(y => y.g), b.litters![1].map(y => y.g));
  assert.deepEqual(a.litters![0].map(y => y.g), c.litters![0].map(y => y.g));
  assert.notDeepEqual(a.litters![0].map(y => y.g), b.litters![0].map(y => y.g));
});

test("illegal moves are refused", () => {
  const m = newMatch(3);
  assert.throws(() => applyBreed(m, [[0, 0], [1, 2]]));
  assert.throws(() => applyBreed(m, [[0, 5], [1, 2]]));
  assert.throws(() => applyField(m, [0, 0]));
  applyBreed(m, [[0, 1], [1, 2]]);
  assert.throws(() => applyBreed(m, [[0, 1], [1, 2]]));
  assert.throws(() => applyField(m, [3, 0]));
  assert.equal(replay(3, [{ pairs: [[0, 1], [1, 1]], fields: [0, 0] }]), null);
  assert.equal(replay(3, [{ pairs: [[0, 1], [1, 2]] }, { pairs: [[0, 1], [1, 2]], fields: [0, 0] }]), null);
  assert.equal(replay(3, [{ pairs: [[0, 1], [1, 2]], fields: [0, 1.5] }]), null);
  assert.equal(replay(3, "nonsense"), null);
});

test("the herd limit releases the oldest non-founder, never a founder", () => {
  let id = 0;
  const mk = (founder: boolean): Creature => ({ id: id++, g: new Uint8Array(C.GENOME_B), founder, born: 0, from: 0 });
  const herd = [mk(true), mk(true), mk(false), mk(true), mk(true), mk(false), mk(true), mk(false), mk(false)];
  const gone = release(herd);
  assert.deepEqual(gone.map(c => c.id), [2, 5]);
  assert.equal(herd.length, HERD_LIMIT);
});

test("the arithmetic exp matches Math.exp over the softmax range", () => {
  for (let x = 0; x >= -60; x -= 0.37) {
    const want = Math.exp(x), got = expArith(x);
    assert.ok(Math.abs(got - want) <= 1e-12 * want + 1e-300, `exp(${x}) ${got} vs ${want}`);
  }
});

test("computer against computer: 200 matches end in seven rounds, invariants hold, replay reproduces, snowball figure", () => {
  const N = 200;
  let decided = 0, r1held = 0, rounds = 0, draws = 0, byHerd = 0, side0 = 0;
  for (let i = 0; i < N; i++) {
    const seed = 7000 + i;
    const m = play(seed);
    rounds += m.history.length;
    const res = m.result!;
    assert.ok(m.history.length <= ROUNDS);
    assert.ok(m.history.length === ROUNDS || Math.max(...m.wins) === TO_WIN, "ended early without four wins");
    if (res.winner === null) draws++;
    else { if (res.winner === 0) side0++; if (res.by === "herd") byHerd++; }
    if (res.winner !== null && m.history[0].winner !== null) {
      decided++;
      if (res.winner === m.history[0].winner) r1held++;
    }

    // Replay: the whole log, and every prefix (mid-round included), gives the same state hash.
    const log = decisions(m);
    assert.equal(hash(replay(seed, log)!), hash(m));
    if (i < 20) {
      const again = newMatch(seed);
      for (let k = 0; k < log.length; k++) {
        applyBreed(again, log[k].pairs);
        assert.equal(hash(replay(seed, [...log.slice(0, k), { pairs: log[k].pairs }])!), hash(again));
        applyField(again, log[k].fields!);
        assert.equal(hash(replay(seed, log.slice(0, k + 1))!), hash(again));
      }
      assert.equal(hash(play(seed, false)), hash(m), "the same seed gave a different computer match");
    }
  }
  const p = r1held / decided, h = 1.96 * Math.sqrt(p * (1 - p) / decided);
  console.log(`DRIFT CHECK  P(round-1 winner wins the match) ${(100 * p).toFixed(1)}% (95% CI ${(100 * (p - h)).toFixed(1)}-${(100 * (p + h)).toFixed(1)}, n=${decided} of ${N} matches)` +
    `  reference mirror deal 66.0% (61.4-70.6); no-snowball 65.6%; drift threshold 75%` +
    `  | rounds ${(rounds / N).toFixed(2)} (reference 5.41)  side-0 wins ${(100 * side0 / (N - draws)).toFixed(1)}%  decided on herd ${byHerd}  draws ${draws}` +
    `  | computer T=${DEFAULT_COMPUTER.T} samples=${DEFAULT_COMPUTER.samples}`);
  assert.ok(p <= 0.75, `P(round-1 winner wins) ${p} is above 75%: the port has drifted from the reference`);
});
