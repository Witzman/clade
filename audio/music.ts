// The two music beds. Not a score: procedurally sequenced synth loops that sit
// under the feedback cues, lowpassed out of the band the cues live in. The
// engine calls `play` once per sixteenth note, a little ahead of time.
//
// Each loop varies from the last (a hash of loop and step picks the arpeggio
// notes and rests), so the loop is heard less as a loop, and it is
// deterministic, so a bed can be re-tuned by ear against the same notes.

import { hz, noise, tone, type Voice } from './synth.ts';

export interface Bed {
  bpm: number;
  /** Sixteenth notes in one loop. */
  steps: number;
  /** Schedule step `i` of loop `loop` at v.t; `s` is one sixteenth, seconds. */
  play(v: Voice, i: number, loop: number, s: number): void;
}

/** Small integer hash, so the variation is fixed per (loop, step). */
function h(a: number, b: number): number {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return (x ^ (x >>> 16)) >>> 0;
}

const CALM_ROOTS = [-24, -27, -31, -29]; // D2, B1, G1, A1: two bars each
const PENTA = [0, 2, 4, 7, 9, 12, 14]; // D4 E4 F#4 A4 B4 D5 E5
const TENSE_ROOTS = [-24, -21, -26, -29]; // D2, F2, C2, A1: one bar each

export const BEDS = {
  /** Choosing and breeding: a drone and a slow pentatonic arpeggio. */
  calm: {
    bpm: 72,
    steps: 128,
    play(v, i, loop, s) {
      if (i % 32 === 0) {
        const root = CALM_ROOTS[(i / 32) % 4];
        const dur = s * 32 + 0.6; // overlaps into the next chord
        tone(v, { type: 'triangle', f: hz(root), dur, attack: 1.2, peak: 0.22, lp: 500 });
        tone(v, { type: 'triangle', f: hz(root + 7), dur, attack: 1.5, peak: 0.12, lp: 500 });
        tone(v, { f: hz(root + 12), dur, attack: 1.8, peak: 0.07 });
      }
      if (i % 2 === 0) {
        const r = h(loop, i);
        if (r % 4 !== 0) tone(v, { f: hz(PENTA[r % PENTA.length]), dur: 0.9, attack: 0.01, peak: 0.08, lp: 2200 });
      }
    },
  },
  /** Commitments against a clock, the replay, crossings: pulse and heartbeat. */
  tense: {
    bpm: 96,
    steps: 64,
    play(v, i, loop, s) {
      const root = TENSE_ROOTS[Math.floor(i / 16) % 4];
      const inBar = i % 16;
      if (i % 2 === 0) {
        tone(v, { type: 'square', f: hz(root), dur: s * 1.6, attack: 0.003,
          peak: inBar % 8 === 0 ? 0.12 : 0.08, lp: 380 });
      }
      if (inBar === 0 || inBar === 3) tone(v, { f: 95, f2: 45, dur: 0.16, attack: 0.002, peak: 0.22 });
      if (i % 4 === 2) noise(v, { filter: 'bandpass', f: 1800, q: 0.9, dur: 0.03, attack: 0.001, peak: 0.05 });
      if (i % 32 === 12 && h(loop, i) % 2 === 0) tone(v, { f: hz(24), dur: 1.2, attack: 0.01, peak: 0.035 });
    },
  },
} satisfies Record<string, Bed>;

export type BedName = keyof typeof BEDS;
export const BED_NAMES = Object.keys(BEDS) as BedName[];
