// The shared feedback set. Names say WHAT HAPPENED, never which screen of which
// variant it happened on; each variant maps its own events onto these.
//
// Everything is in D (pentatonic major for good news, a minor inflection for
// bad), so cues fired at random moments never clash with each other or a bed.
// Pitches are semitones from D4: D5 = 12, A5 = 19, D6 = 24.

import { bell, hz, noise, tone, type Voice } from './synth.ts';

export interface Cue {
  /** 0 routine … 3 outcome. Under the voice cap, a cue may steal only a lower one. */
  prio: 0 | 1 | 2 | 3;
  /** At most this many instances of the cue at once. */
  cap: number;
  /** A retrigger inside this many seconds is dropped: one frame, one sound. */
  gap: number;
  /** Upper bound on how long the cue lasts, seconds. Asserted by the test. */
  length: number;
  /** Schedules the cue; returns when it is silent, relative to v.t. */
  render(v: Voice): number;
}

const max = Math.max;
const BIRTH = [12, 14, 16, 19, 21, 24];

export const CUES = {
  /** A selection landed. The quietest sound in the set. */
  tap: { prio: 0, cap: 2, gap: 0.03, length: 0.08, render: v =>
    tone(v, { f: hz(31), dur: 0.04, attack: 0.002, peak: 0.16 }) },

  /** A choice committed. */
  confirm: { prio: 1, cap: 2, gap: 0.05, length: 0.2, render: v => max(
    tone(v, { type: 'triangle', f: hz(19), dur: 0.07, peak: 0.26 }),
    tone(v, { type: 'triangle', f: hz(24), at: 0.06, dur: 0.09, peak: 0.26 })) },

  /** Deselect, back, release. The mirror of confirm, not a failure. */
  cancel: { prio: 0, cap: 2, gap: 0.05, length: 0.2, render: v => max(
    tone(v, { type: 'triangle', f: hz(19), dur: 0.07, peak: 0.2 }),
    tone(v, { type: 'triangle', f: hz(14), at: 0.06, dur: 0.08, peak: 0.2 })) },

  /** An action refused. The one deliberately rough timbre. */
  deny: { prio: 2, cap: 1, gap: 0.15, length: 0.22, render: v => max(
    tone(v, { type: 'square', f: hz(-12), dur: 0.07, peak: 0.12, lp: 900 }),
    tone(v, { type: 'square', f: hz(-12) * 1.012, dur: 0.07, peak: 0.08, lp: 900 }),
    tone(v, { type: 'square', f: hz(-12), at: 0.1, dur: 0.08, peak: 0.12, lp: 900 }),
    tone(v, { type: 'square', f: hz(-12) * 1.012, at: 0.1, dur: 0.08, peak: 0.08, lp: 900 })) },

  /** The last seconds of a timer; intensity > 0.5 is the final one. */
  tick: { prio: 1, cap: 1, gap: 0.2, length: 0.08, render: v => max(
    tone(v, { f: v.intensity > 0.5 ? hz(29) : hz(24), dur: 0.045, attack: 0.001, peak: 0.28 }),
    noise(v, { filter: 'highpass', f: 3000, dur: 0.012, attack: 0.001, peak: 0.1 })) },

  /** Something outside your own action needs your attention. */
  alert: { prio: 2, cap: 1, gap: 0.4, length: 0.75, render: v => max(
    bell(v, { f: hz(19), ratio: 3.5, index: 1.2, dur: 0.7, peak: 0.3 }),
    bell(v, { f: hz(26), ratio: 3.5, index: 0.8, at: 0.09, dur: 0.6, peak: 0.16 })) },

  /** A young appears. Pass step 0, 1, 2 across a litter: it reads as a phrase. */
  birth: { prio: 1, cap: 4, gap: 0.07, length: 0.35, render: v =>
    tone(v, { type: 'triangle', f: hz(BIRTH[((Math.trunc(v.step) % 6) + 6) % 6]), dur: 0.3,
      attack: 0.004, peak: 0.26, lp: 4000, lp2: 900 }) },

  /** Something new: rare and bright, so it is noticed. */
  discover: { prio: 2, cap: 1, gap: 0.25, length: 0.52, render: v => max(
    bell(v, { f: hz(31), ratio: 2, index: 0.5, dur: 0.25, peak: 0.14 }),
    bell(v, { f: hz(36), ratio: 2, index: 0.5, at: 0.08, dur: 0.25, peak: 0.14 }),
    bell(v, { f: hz(40), ratio: 2, index: 0.5, at: 0.16, dur: 0.3, peak: 0.14 })) },

  /** A blow lands. Intensity carries how hard. */
  hit: { prio: 1, cap: 3, gap: 0.05, length: 0.18, render: v => max(
    noise(v, { filter: 'lowpass', f: 900 + 2600 * v.intensity, dur: 0.07, attack: 0.001,
      peak: 0.16 + 0.2 * v.intensity }),
    tone(v, { f: 220, f2: 55, dur: 0.14, attack: 0.002, peak: 0.28 + 0.2 * v.intensity })) },

  /** A blow absorbed or softened: harder and brighter than a hit, no thump. */
  block: { prio: 1, cap: 3, gap: 0.05, length: 0.12, render: v => max(
    noise(v, { filter: 'bandpass', f: 2400, q: 6, dur: 0.05, attack: 0.001, peak: 0.5 }),
    tone(v, { type: 'square', f: 620, dur: 0.07, attack: 0.001, peak: 0.05, lp: 3000 }),
    tone(v, { type: 'square', f: 913, dur: 0.06, attack: 0.001, peak: 0.04, lp: 3000 })) },

  /** A blow fails to land: air, no contact. */
  miss: { prio: 0, cap: 3, gap: 0.05, length: 0.22, render: v =>
    noise(v, { filter: 'bandpass', f: 500, f2: 3200, q: 1.2, dur: 0.18, attack: 0.07,
      peak: 0.12 + 0.1 * v.intensity }) },

  /** A fight ends. */
  ko: { prio: 3, cap: 1, gap: 0.25, length: 0.56, render: v => max(
    tone(v, { f: 130, f2: 38, dur: 0.5, attack: 0.003, peak: 0.7 }),
    noise(v, { filter: 'lowpass', f: 500, dur: 0.22, attack: 0.002, peak: 0.35 }),
    tone(v, { type: 'triangle', f: 220, f2: 55, dur: 0.45, peak: 0.15 })) },

  /** A creature joins your herd. */
  gain: { prio: 2, cap: 1, gap: 0.25, length: 0.5, render: v => max(
    tone(v, { type: 'triangle', f: hz(12), dur: 0.16, peak: 0.22 }),
    tone(v, { type: 'triangle', f: hz(16), at: 0.1, dur: 0.16, peak: 0.22 }),
    tone(v, { type: 'triangle', f: hz(19), at: 0.2, dur: 0.24, peak: 0.22 }),
    tone(v, { f: hz(31), at: 0.2, dur: 0.24, peak: 0.05 })) },

  /** One of yours leaves your herd. Loss, not punishment. */
  loss: { prio: 2, cap: 1, gap: 0.25, length: 0.55, render: v => max(
    tone(v, { type: 'triangle', f: hz(7), dur: 0.26, peak: 0.24, lp: 1300 }),
    tone(v, { type: 'triangle', f: hz(3), at: 0.18, dur: 0.32, peak: 0.24, lp: 1100 })) },

  /** A round, match or stop won. */
  win: { prio: 3, cap: 1, gap: 0.25, length: 1.0, render: v => max(
    tone(v, { type: 'triangle', f: hz(12), dur: 0.14, peak: 0.24 }),
    tone(v, { type: 'triangle', f: hz(16), at: 0.11, dur: 0.14, peak: 0.24 }),
    tone(v, { type: 'triangle', f: hz(19), at: 0.22, dur: 0.14, peak: 0.24 }),
    tone(v, { type: 'triangle', f: hz(24), at: 0.33, dur: 0.6, peak: 0.26 }),
    tone(v, { f: hz(12), at: 0.33, dur: 0.6, peak: 0.12 })) },

  /** A round, match or stop lost; a run ended. Gentler than deny. */
  lose: { prio: 3, cap: 1, gap: 0.25, length: 1.1, render: v => max(
    tone(v, { type: 'triangle', f: hz(7), dur: 0.24, peak: 0.24, lp: 1200 }),
    tone(v, { type: 'triangle', f: hz(3), at: 0.2, dur: 0.24, peak: 0.24, lp: 1200 }),
    tone(v, { type: 'triangle', f: hz(0), at: 0.4, dur: 0.62, peak: 0.26, lp: 900 }),
    tone(v, { f: hz(-12), at: 0.4, dur: 0.62, peak: 0.2 })) },
} satisfies Record<string, Cue>;

export type CueName = keyof typeof CUES;
export const CUE_NAMES = Object.keys(CUES) as CueName[];
