// The three building blocks every cue and bed is made of: a tone, filtered
// noise, and a two-operator FM bell. Each schedules its own nodes at `v.t` and
// returns when it falls silent, relative to `v.t`, so a caller knows how long
// its voice lasts without listening.

import type { ABuffer, ACtx, ANode, AParam } from './types.ts';

/** Where a sound is scheduled, and the per-play variation applied to it. */
export interface Voice {
  ctx: ACtx;
  out: ANode;
  /** Start time on the context clock, in seconds. */
  t: number;
  /** Frequency ratio: random detune per play, 1 for none. */
  det: number;
  /** 0..1 — loudness and brightness, where a recipe uses it. */
  intensity: number;
  /** Scale degree, for cues played as a sequence. */
  step: number;
}

/** Exponential ramps cannot reach 0; this is silence for them. */
const FLOOR = 0.0001;
/** Tail left on a source after its envelope ends. */
const TAIL = 0.02;

/** Frequency of a pitch given in semitones from D4, the set's tonal centre. */
export const hz = (semitones: number): number => 293.66 * Math.pow(2, semitones / 12);

function envelope(p: AParam, t: number, attack: number, peak: number, dur: number): void {
  const top = Math.max(peak, FLOOR * 10);
  p.setValueAtTime(FLOOR, t);
  p.linearRampToValueAtTime(top, t + Math.min(attack, dur * 0.5));
  p.exponentialRampToValueAtTime(FLOOR, t + dur);
}

/** Optional lowpass between a gain stage and the voice output. */
function lowpassed(v: Voice, from: ANode, t: number, cutoff: number | undefined, cutoffEnd?: number): void {
  if (!cutoff) { from.connect(v.out); return; }
  const f = v.ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.7;
  f.frequency.setValueAtTime(cutoff, t);
  if (cutoffEnd) f.frequency.exponentialRampToValueAtTime(cutoffEnd, t + 0.25);
  from.connect(f);
  f.connect(v.out);
}

export interface ToneSpec {
  type?: 'sine' | 'triangle' | 'square' | 'sawtooth';
  /** Start frequency, Hz. */
  f: number;
  /** End frequency, Hz, reached at the end of `dur` (exponential glide). */
  f2?: number;
  /** Offset from the voice start, seconds. */
  at?: number;
  dur: number;
  attack?: number;
  peak: number;
  lp?: number;
  lp2?: number;
}

export function tone(v: Voice, s: ToneSpec): number {
  const t = v.t + (s.at ?? 0);
  const osc = v.ctx.createOscillator();
  osc.type = s.type ?? 'sine';
  osc.frequency.setValueAtTime(s.f * v.det, t);
  if (s.f2) osc.frequency.exponentialRampToValueAtTime(s.f2 * v.det, t + s.dur);
  const g = v.ctx.createGain();
  envelope(g.gain, t, s.attack ?? 0.005, s.peak, s.dur);
  osc.connect(g);
  lowpassed(v, g, t, s.lp, s.lp2);
  osc.start(t);
  osc.stop(t + s.dur + TAIL);
  return (s.at ?? 0) + s.dur + TAIL;
}

/** One second of white noise per context, made once. */
const noiseBuffers = new WeakMap<ACtx, ABuffer>();
function noiseBuffer(ctx: ACtx): ABuffer {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  return b;
}

export interface NoiseSpec {
  filter: 'lowpass' | 'highpass' | 'bandpass';
  f: number;
  f2?: number;
  q?: number;
  at?: number;
  dur: number;
  attack?: number;
  peak: number;
}

export function noise(v: Voice, s: NoiseSpec): number {
  const t = v.t + (s.at ?? 0);
  const src = v.ctx.createBufferSource();
  src.buffer = noiseBuffer(v.ctx);
  const f = v.ctx.createBiquadFilter();
  f.type = s.filter;
  f.Q.value = s.q ?? 0.7;
  f.frequency.setValueAtTime(s.f, t);
  if (s.f2) f.frequency.exponentialRampToValueAtTime(s.f2, t + s.dur);
  const g = v.ctx.createGain();
  envelope(g.gain, t, s.attack ?? 0.002, s.peak, s.dur);
  src.connect(f);
  f.connect(g);
  g.connect(v.out);
  // A random offset into the buffer, so two identical impacts are not one sample.
  src.start(t, Math.random() * 0.4);
  src.stop(t + s.dur + TAIL);
  return (s.at ?? 0) + s.dur + TAIL;
}

export interface BellSpec {
  f: number;
  /** Modulator frequency as a multiple of `f`. Non-integer ratios ring like metal. */
  ratio: number;
  /** Modulation depth as a multiple of `f`; decays to nothing, so the tone softens. */
  index: number;
  at?: number;
  dur: number;
  peak: number;
}

export function bell(v: Voice, s: BellSpec): number {
  const t = v.t + (s.at ?? 0);
  const f = s.f * v.det;
  const car = v.ctx.createOscillator();
  car.frequency.setValueAtTime(f, t);
  const mod = v.ctx.createOscillator();
  mod.frequency.setValueAtTime(f * s.ratio, t);
  const depth = v.ctx.createGain();
  depth.gain.setValueAtTime(f * s.index, t);
  depth.gain.exponentialRampToValueAtTime(Math.max(f * 0.001, FLOOR), t + s.dur);
  mod.connect(depth);
  depth.connect(car.frequency);
  const g = v.ctx.createGain();
  envelope(g.gain, t, 0.003, s.peak, s.dur);
  car.connect(g);
  g.connect(v.out);
  car.start(t); mod.start(t);
  car.stop(t + s.dur + TAIL); mod.stop(t + s.dur + TAIL);
  return (s.at ?? 0) + s.dur + TAIL;
}
