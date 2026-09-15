// /replay-test: the shared fight replay (ui/replay.ts) on fights bred by core/,
// and an in-browser run of the same equality the CI test asserts: the replay's
// events, folded alone, give core.fight()'s hit points bit for bit. Workshop
// issue #60. A headless run reads `window.replayTest`.

import { breed, express, fight, founder, int, label, rng, stats, type Genome, type Stats } from '../../core/index.ts';
import { fightEvents, type FightRecord } from '../../ui/fight-events.ts';
import { mountReplay, type Replay } from '../../ui/replay.ts';

const $ = (id: string) => document.getElementById(id)!;
const results: Record<string, unknown> = {};
(window as unknown as { replayTest: unknown }).replayTest = results;

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0);
$('seedinfo').textContent = `seed ${seed}`;
(document.getElementById('reroll') as HTMLAnchorElement).href = `?seed=${(seed * 2654435761 + 1) >>> 0}`;

type Bout = { a: Genome; b: Genome; A: Stats; B: Stats; rec: FightRecord };

/** A pool bred for a few generations, and fights drawn from it. */
function bouts(n: number): Bout[] {
  const r = rng(seed);
  let pool: Genome[] = [];
  for (let i = 0; i < 24; i++) pool.push(founder(r));
  for (let g = 0; g < 6; g++) pool = pool.map(() => breed(pool[int(r, pool.length)], pool[int(r, pool.length)], r).child);
  const out: Bout[] = [];
  for (let i = 0; i < n; i++) {
    const a = pool[int(r, pool.length)], b = pool[int(r, pool.length)];
    const A = stats(express(a)), B = stats(express(b));
    out.push({ a, b, A, B, rec: fightEvents(A, B) });
  }
  return out;
}

const actions = (x: Bout) => x.rec.events.filter(e => e.kind === 'strike').length;
const all = bouts(300).sort((x, y) => actions(x) - actions(y));
const picks: Record<string, Bout> = {
  short: all.find(x => actions(x) >= 3) ?? all[0],
  median: all[Math.floor(all.length / 2)],
  long: all[Math.floor(all.length * 0.9)],
};

let current: Replay | null = null;
let chosen = 'median';
function play(which: string): void {
  chosen = which;
  current?.destroy();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pick]'))
    b.setAttribute('aria-pressed', String(b.dataset.pick === which));
  const bout = picks[which];
  results.playing = { which, actions: actions(bout), ended: false, eventsShown: 0 };
  const status = results.playing as { ended: boolean; eventsShown: number; skipped?: boolean };
  current = mountReplay($('stage'), bout.rec, {
    names: { A: label(bout.a), B: label(bout.b) },
    onEvent: (_e, _i, skipped) => { status.eventsShown++; if (skipped) status.skipped = true; },
    onEnd: () => { status.ended = true; },
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pick]'))
  b.addEventListener('click', () => play(b.dataset.pick!));
$('again').addEventListener('click', () => play(chosen));
play('median');

// ---- equality in this engine ----------------------------------------------

const f64 = new Float64Array(1);
const u8 = new Uint8Array(f64.buffer);
const same = (x: number, y: number) => {
  f64[0] = x; const a = Array.from(u8);
  f64[0] = y; return a.every((v, i) => v === u8[i]);
};

setTimeout(() => {
  const t0 = performance.now();
  const r = rng(seed ^ 0x5eed);
  const pool: Genome[] = [];
  for (let i = 0; i < 60; i++) pool.push(founder(r));
  while (pool.length < 400) pool.push(breed(pool[int(r, pool.length)], pool[int(r, pool.length)], r).child);
  const N = 2000;
  let equal = 0;
  let maxMs = 0;
  for (let k = 0; k < N; k++) {
    const A = stats(express(pool[int(r, pool.length)])), B = stats(express(pool[int(r, pool.length)]));
    const core = fight(A, B);
    const s = performance.now();
    const rec = fightEvents(A, B);
    maxMs = Math.max(maxMs, performance.now() - s);
    let hpA = A.hp, hpB = B.hp;
    for (const e of rec.events) if (e.kind === 'strike') {
      if (e.side === 'A') { hpB -= e.damage; hpA -= e.riposte; } else { hpA -= e.damage; hpB -= e.riposte; }
    }
    if (same(hpA, core.hpA) && same(hpB, core.hpB) && rec.t === core.t) equal++;
  }
  const ms = performance.now() - t0;
  Object.assign(results, { fights: N, equal, ms: Math.round(ms), maxEventsMs: Number(maxMs.toFixed(2)) });
  $('check').textContent =
    `${equal} of ${N} fights: events equal core.fight() bit for bit ${equal === N ? '(PASS)' : '(FAIL)'}\n` +
    `resolved in ${Math.round(ms)} ms; slowest single fight's events ${maxMs.toFixed(2)} ms\n` +
    `${navigator.userAgent}`;
  if (equal !== N) { $('error').hidden = false; $('error').textContent = 'Replay events disagree with the core.'; }
}, 50);
