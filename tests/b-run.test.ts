// Variant B's run engine, rival generator and computer expedition (web/b/,
// workshop issue #63, build plan 2026-09-15 piece B1).
//
// Run: node --test tests/b-run.test.ts
//
// The port check prints the finished share and mean end stop of the computer
// policy (the heuristic player: scorer breeding, answering lineup, keep one)
// over 60 run seeds. The reference is the measured H/H figure of the variant
// directions section 2.7: 82 % finished, mean end stop 9.00, 3 of 60 dead at
// stop 1. It prints and does not fail: a large gap is a finding about the port,
// recorded on the issue, not a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newRun, apply, illegal, replay, hash, eligible, stepping, upcoming,
  PLAYER, COMPUTER, STOPS, HERD_CAP, LINEUP, DEFAULT_OPTIONS,
} from "../web/b/run.ts";
import type { Run, Decision, RunOptions } from "../web/b/run.ts";
import { fits, tierOf, stream, isCrossing } from "../web/b/base.ts";
import {
  chooseFounders, choosePair, chooseKeep, chooseRelease, chooseThree, chooseAnswer,
  REFERENCE_POLICY, DEFAULT_POLICY,
} from "../web/b/computer.ts";
import type { Policy } from "../web/b/computer.ts";
import { rivalAt, generation } from "../web/b/rivals.ts";
import { rng, int } from "../core/index.ts";

const PLAYER_SAMPLE = 101, PLAYER_CHOICE = 102;

// The next decision of the heuristic player, from the state a client sees.
function heuristic(run: Run, p: Policy): Decision {
  const me = run.exps[PLAYER], g = me.herd.map(c => c.g);
  const c = { herd: g, seen: me.seen, route: run.route, stop: run.stop };
  const r = (k: number) => stream(run.seed, PLAYER_CHOICE, run.stop, k);
  switch (run.phase) {
    case "founders": return { t: "founders", pick: chooseFounders(run.deal) };
    case "breed": {
      const [i, j] = choosePair(c, stream(run.seed, PLAYER_SAMPLE, run.stop, 0), p);
      return { t: "breed", ids: [me.herd[i].id, me.herd[j].id] };
    }
    case "keep": return { t: "keep", i: chooseKeep(run.litter!.map(y => y.g), c) };
    case "release": return { t: "release", ids: chooseRelease(c).map(i => me.herd[i].id) };
    case "lineup": {
      const fit = eligible(run);
      return { t: "lineup", ids: chooseThree(fit.map(x => x.g), run.opponent!.map(x => x.g), p, r(0)).map(i => fit[i].id) };
    }
    case "answer": {
      const lineup = run.lineup!.map(id => me.herd.find(x => x.id === id)!.g);
      return { t: "answer", slot: chooseAnswer(lineup, run.opponent!.map(x => x.g), run.mineLeft, run.theirsLeft,
        run.wins, run.order![run.step], p, r(1 + run.step)) };
    }
    default: throw new Error("over");
  }
}

// Uniformly random legal decisions.
function random(run: Run, seed: number): Decision {
  const r = rng(seed ^ (run.log.length * 2654435761));
  const me = run.exps[PLAYER];
  const shuffle = <T>(xs: T[]) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = int(r, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
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

type Chooser = (run: Run) => Decision;
function play(seed: number, choose: Chooser, opts: RunOptions = DEFAULT_OPTIONS, check = true): Run {
  const run = newRun(seed, opts);
  let guard = 0;
  while (run.phase !== "over") {
    const d = choose(run);
    assert.equal(illegal(run, d), null, `seed ${seed}: the chooser made an illegal ${d.t}`);
    if (check && d.t === "lineup") {
      const fit = eligible(run);
      assert.ok(run.opponent!.length <= LINEUP);
      if (!isCrossing(run.stop)) for (const c of run.opponent!) assert.ok(fits(upcoming(run)[0], tierOf(c.g)), "a rival creature is over the limit");
      assert.equal(d.ids.length, Math.min(LINEUP, fit.length));
      assert.ok(run.exps[PLAYER].herd.length <= HERD_CAP, "herd above eight at the lineup");
    }
    apply(run, d);
    assert.ok(++guard < 200, "run did not end");
  }
  if (check) {
    for (const X of run.exps) for (const s of X.stops) {
      assert.ok(s.lineup.length <= LINEUP && s.opponent.length <= LINEUP);
      assert.ok(s.fights.length <= Math.min(s.lineup.length, s.opponent.length));
    }
    assert.ok(run.stop <= STOPS);
  }
  return run;
}

test("every lineup respects its limit, and illegal decisions are refused", () => {
  const p = (run: Run) => heuristic(run, DEFAULT_POLICY);
  for (let seed = 1; seed <= 6; seed++) {
    const run = play(seed, p);
    for (const X of run.exps) for (const s of X.stops) {
      const ids = new Map([...s.opponent, ...run.exps[0].herd, ...run.exps[1].herd].map(c => [c.id, c]));
      for (const c of s.opponent) if (!s.crossing) assert.ok(fits(s.limit, tierOf(c.g)));
      for (const f of s.fights) void ids;
    }
  }
  // Illegal moves at each phase.
  const run = newRun(3);
  assert.notEqual(illegal(run, { t: "founders", pick: [0, 0, 1] }), null);
  assert.notEqual(illegal(run, { t: "founders", pick: [0, 1, 6] }), null);
  assert.notEqual(illegal(run, { t: "breed", ids: [0, 1] }), null);
  apply(run, { t: "founders", pick: [0, 1, 2] });
  const ids = run.exps[PLAYER].herd.map(c => c.id);
  assert.notEqual(illegal(run, { t: "breed", ids: [ids[0], ids[0]] }), null);
  assert.notEqual(illegal(run, { t: "breed", ids: [ids[0], 9999] }), null);
  assert.notEqual(illegal(run, { t: "keep", i: 0 }), null);
  apply(run, { t: "breed", ids: [ids[0], ids[1]] });
  assert.notEqual(illegal(run, { t: "keep", i: 3 }), null);
  apply(run, { t: "keep", i: 0 });
  if (run.phase === "lineup") {
    const fit = eligible(run).map(c => c.id);
    const unfit = run.exps[PLAYER].herd.filter(c => !fit.includes(c.id)).map(c => c.id);
    if (unfit.length) assert.notEqual(illegal(run, { t: "lineup", ids: [unfit[0], ...fit].slice(0, Math.min(LINEUP, fit.length)) }), null);
    assert.notEqual(illegal(run, { t: "lineup", ids: fit.slice(0, Math.min(LINEUP, fit.length) - 1) }), null);
  }
  assert.equal(replay(3, "nonsense"), null);
  assert.equal(replay(3, [{ t: "breed", ids: [0, 1] }]), null);
  assert.equal(replay(3, [{ t: "founders", pick: [0, 1, 2] }, { t: "founders", pick: [0, 1, 2] }]), null);
});

test("the same log gives the same hash, at every prefix", () => {
  for (let seed = 11; seed <= 16; seed++) {
    const run = play(seed, seed % 2 ? (r: Run) => heuristic(r, DEFAULT_POLICY) : (r: Run) => random(r, seed));
    assert.equal(hash(replay(seed, run.log)!), hash(run));
    assert.equal(hash(play(seed, seed % 2 ? (r: Run) => heuristic(r, DEFAULT_POLICY) : (r: Run) => random(r, seed), DEFAULT_OPTIONS, false)), hash(run));
    const again = newRun(seed);
    for (let k = 0; k < run.log.length; k++) {
      apply(again, run.log[k]);
      assert.equal(hash(replay(seed, run.log.slice(0, k + 1))!), hash(again), `seed ${seed} prefix ${k + 1}`);
    }
    assert.deepEqual(replay(seed, run.log)!.result, run.result);
  }
});

test("a reload shows the same litter and the same rival order; neither can be rerolled", () => {
  const seed = 21;
  const run = play(seed, r => heuristic(r, DEFAULT_POLICY));
  let litters = 0, orders = 0;
  for (let k = 1; k <= run.log.length; k++) {
    const d = run.log[k - 1];
    const at = replay(seed, run.log.slice(0, k))!;
    if (at.phase === "keep") {
      // Reload: the same young. Reroll attempt: back out, choose the same pair again.
      const back = replay(seed, run.log.slice(0, k - 1))!;
      apply(back, d);
      assert.deepEqual(back.litter!.map(y => y.g), at.litter!.map(y => y.g));
      assert.deepEqual(replay(seed, run.log.slice(0, k))!.litter!.map(y => y.g), at.litter!.map(y => y.g));
      litters++;
    }
    if (at.phase === "lineup" || at.phase === "answer") {
      const again = replay(seed, run.log.slice(0, k))!;
      assert.deepEqual(again.order, at.order);
      assert.deepEqual(again.opponent!.map(c => c.g), at.opponent!.map(c => c.g));
      assert.deepEqual(stepping(again)?.g, stepping(at)?.g);
      if (at.phase === "lineup") {
        // The order is fixed when the lineup opens: a different lineup meets the same order.
        const fit = eligible(at);
        if (fit.length > LINEUP) {
          const a = replay(seed, run.log.slice(0, k))!, b = replay(seed, run.log.slice(0, k))!;
          apply(a, { t: "lineup", ids: fit.slice(0, LINEUP).map(c => c.id) });
          apply(b, { t: "lineup", ids: fit.slice(fit.length - LINEUP).map(c => c.id) });
          assert.deepEqual(a.exps[PLAYER].stops.length ? a.exps[PLAYER].stops.at(-1)!.order : a.order,
                           b.exps[PLAYER].stops.length ? b.exps[PLAYER].stops.at(-1)!.order : b.order);
        }
        orders++;
      }
    }
  }
  assert.ok(litters >= 1 && orders >= 1, `checked ${litters} litters and ${orders} orders`);
  // Everyone on the same seed meets the same rival herds.
  for (const stop of [1, 2, 4, 5, 7, 8]) assert.deepEqual(rivalAt(77, stop, "any"), rivalAt(77, stop, "any"));
  assert.equal(generation(77, 16).length, 6);
});

test("keep-one runs end, and the port figure against section 2.7", () => {
  const SEEDS = Array.from({ length: 60 }, (_, i) => 5000 + i);
  const t0 = Date.now();
  type Row = { end: number; herd: number; won: number };
  const measure = (name: string, choose: (run: Run) => Decision, opts: RunOptions) => {
    const rows: Row[] = [], cpu: Row[] = [], results: (0 | 1 | null)[] = [];
    let lowest = Infinity;
    for (const seed of SEEDS) {
      const run = play(seed, choose, opts);
      const [P, C] = run.exps;
      rows.push({ end: P.end, herd: P.herd.length, won: P.fightsWon });
      cpu.push({ end: C.end, herd: C.herd.length, won: C.fightsWon });
      results.push(run.result!.winner);
      for (const s of P.stops) lowest = Math.min(lowest, run.exps[PLAYER].herd.length);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fin = rows.filter(r => r.end === STOPS + 1).length;
    const hist = Array.from({ length: STOPS + 1 }, (_, i) => rows.filter(r => r.end === i + 1).length);
    const cfin = cpu.filter(r => r.end === STOPS + 1).length;
    console.log(`${name}: mean end stop ${mean(rows.map(r => r.end)).toFixed(2)}  finished ${(100 * fin / rows.length).toFixed(0)}%` +
      `  died at stop 1 ${hist[0]}/${rows.length}  end-stop histogram 1..10 [${hist.join(", ")}]` +
      `  herd at end ${mean(rows.map(r => r.herd)).toFixed(1)}  fights won ${mean(rows.map(r => r.won)).toFixed(1)}` +
      `  | computer expedition: mean end stop ${mean(cpu.map(r => r.end)).toFixed(2)} finished ${(100 * cfin / cpu.length).toFixed(0)}%` +
      `  | winner player ${results.filter(w => w === 0).length} computer ${results.filter(w => w === 1).length} draw ${results.filter(w => w === null).length}`);
    return { fin: fin / rows.length, meanEnd: mean(rows.map(r => r.end)), hist };
  };

  // The reference policy (argmax), playing on after the computer ends, as measure5.py's player did.
  const ref = measure("PORT CHECK heuristic policy T=0, play on", r => heuristic(r, REFERENCE_POLICY),
    { policy: REFERENCE_POLICY, selection: true, playOn: true });
  const h = 1.96 * Math.sqrt(0.82 * 0.18 / 60);
  const gap = Math.abs(ref.fin - 0.82) > h || Math.abs(ref.meanEnd - 9.0) > 1.0;
  console.log(`PORT CHECK  finished ${(100 * ref.fin).toFixed(0)}% vs reference 82% (±${(100 * h).toFixed(0)} at n=60)` +
    `  mean end stop ${ref.meanEnd.toFixed(2)} vs 9.00  -> ${gap ? "LARGE GAP: a FINDING about the port" : "within the reference's interval"}`);

  // As the game runs it: default softmax, the run ends when either expedition ends (section 5.4).
  measure("section 5.4 as built, heuristic player vs computer expedition, default policy", r => heuristic(r, DEFAULT_POLICY), DEFAULT_OPTIONS);
  // A random player must be able to lose its expedition: keep one has no treadmill.
  const rnd = measure("random player", r => random(r, r.seed), { ...DEFAULT_OPTIONS, playOn: true });
  assert.ok(rnd.hist.slice(0, STOPS).reduce((a, b) => a + b, 0) > 0, "no random keep-one run ended before stop 9");
  assert.ok(ref.hist.reduce((a, b) => a + b, 0) === SEEDS.length);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s for 180 runs)`);
});

test("rivals without selection (the B1a fallback) still field three within the limit", () => {
  for (const stop of [1, 4, 8]) for (const lim of ["any", "small-or-smaller", "big-or-larger"] as const) {
    const r = rivalAt(9, stop, lim, false);
    assert.ok(r.length <= 3);
    for (const g of r) assert.ok(fits(lim, tierOf(g)));
  }
  void COMPUTER;
});
