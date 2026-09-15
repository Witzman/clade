// Shared audio for every variant: named feedback cues, two music beds, master
// mute and volume. All of it synthesised with Web Audio — no files.
//
//   import { sharedAudio } from '../../audio/index.ts';
//   const audio = sharedAudio();
//   audio.music('calm');             // starts at the first user gesture
//   audio.play('hit', { intensity: 0.7, pan: -0.4 });
//
// What it guarantees:
// - No AudioContext exists before the first pointerdown, keydown or touchend.
//   A play() before that is dropped, not queued: late feedback is wrong feedback.
//   music() before that records intent.
// - Muted means no work: play() returns before touching Web Audio, the context
//   is suspended, the scheduler timer is cleared. Mute is remembered in
//   localStorage under a key that is never renamed, and nothing re-enables it.
// - A hidden tab suspends the context and stops the scheduler.
// - At most MAX_VOICES cues sound at once; a cue may only steal a voice of lower
//   priority. Each cue also has its own instance cap and retrigger gap.

import { CUES, CUE_NAMES, type CueName } from './cues.ts';
import { BEDS, BED_NAMES, type BedName } from './music.ts';
import type { ACompressor, ACtx, AGain, ANode } from './types.ts';

export { CUES, CUE_NAMES, BEDS, BED_NAMES };
export type { CueName, BedName };
export type { ACtx } from './types.ts';

export const MAX_VOICES = 12;
export const STORAGE_KEY = 'clade.audio';
export const DEFAULT_VOLUME = 0.8;
/** The music bus under the cue bus: about -13 dB. */
export const MUSIC_LEVEL = 0.22;
/** Music bus level while a priority >= 2 cue sounds. */
const DUCK = 0.45;
const DUCK_HOLD = 0.35;
const LOOKAHEAD = 0.12;
const PUMP_MS = 25;
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

export interface PlayOptions {
  /** 0..1, default 0.5. */
  intensity?: number;
  /** Scale degree for sequences, e.g. 0,1,2 across a litter. */
  step?: number;
  /** -1 left … 1 right. */
  pan?: number;
}

export interface Settings { muted: boolean; volume: number; musicOn: boolean }

export interface AudioState extends Settings {
  /** A user gesture has been seen. */
  unlocked: boolean;
  contextCreated: boolean;
  /** Not muted, not hidden, context resumed. */
  running: boolean;
  /** The bed asked for, whether or not it can sound yet. */
  bed: BedName | null;
  /** The bed actually being scheduled. */
  playingBed: BedName | null;
  voices: number;
}

export interface SharedAudio {
  play(cue: CueName, options?: PlayOptions): boolean;
  music(bed: BedName | null): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  setMusicOn(on: boolean): void;
  /** Treat this call as the user gesture. Normally the listeners do it. */
  unlock(): void;
  readonly state: AudioState;
  /** The context, once created. For meters and tests, not for playing sounds. */
  readonly context: ACtx | null;
  /** The final node before the destination. For meters. */
  readonly output: ANode | null;
  dispose(): void;
}

interface Listenable {
  addEventListener(type: string, fn: () => void, options?: { capture?: boolean }): void;
  removeEventListener(type: string, fn: () => void, options?: { capture?: boolean }): void;
}
interface DocLike extends Listenable { hidden: boolean }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface Timer { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface AudioOptions {
  /** Default: a real AudioContext, or null where Web Audio is missing. */
  createContext?: () => ACtx | null;
  /** Default: localStorage, if reachable. null for none. */
  storage?: StorageLike | null;
  /** Where the gesture listeners go. Default: window. null for none. */
  gestureTarget?: Listenable | null;
  /** Default: document. null for none. */
  document?: DocLike | null;
  timer?: Timer;
  random?: () => number;
}

const g = globalThis as unknown as {
  AudioContext?: new (o?: object) => ACtx;
  webkitAudioContext?: new (o?: object) => ACtx;
  localStorage?: StorageLike;
  document?: DocLike;
  addEventListener?: Listenable['addEventListener'];
  removeEventListener?: Listenable['removeEventListener'];
};

function defaultContext(): ACtx | null {
  const C = g.AudioContext ?? g.webkitAudioContext;
  return C ? new C({ latencyHint: 'interactive' }) : null;
}

function defaultStorage(): StorageLike | null {
  try { return g.localStorage ?? null; } catch { return null; } // throws in some sandboxes
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const finite = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/** Tolerant: extra fields ignored, missing ones defaulted, `muted: true` always survives. */
export function readSettings(storage: StorageLike | null): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const text = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch { /* unreadable settings are defaults, never an error */ }
  return {
    muted: raw.muted === true,
    volume: clamp(finite(raw.volume, DEFAULT_VOLUME), 0, 1),
    musicOn: raw.musicOn !== false,
  };
}

interface Live { cue: CueName; prio: number; endsAt: number; nodes: ANode[]; gain: AGain }

export function createAudio(options: AudioOptions = {}): SharedAudio {
  const makeContext = options.createContext ?? defaultContext;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const target: Listenable | null = options.gestureTarget === undefined
    ? (g.addEventListener ? (g as unknown as Listenable) : null)
    : options.gestureTarget;
  const doc = options.document === undefined ? (g.document ?? null) : options.document;
  const timer: Timer = options.timer ?? { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as number) };
  const random = options.random ?? Math.random;

  const settings = readSettings(storage);
  let unlocked = false;
  let hidden = doc?.hidden ?? false;
  let bedIntent: BedName | null = null;

  let ctx: ACtx | null = null;
  let master: AGain | null = null;
  let limiter: ACompressor | null = null;
  let sfxBus: AGain | null = null;
  let musicBus: AGain | null = null;
  let suspended = false;

  let playingBed: BedName | null = null;
  let bedGain: AGain | null = null;
  let nextStep = 0;
  let stepIndex = 0;
  let loop = 0;
  let pumpHandle: unknown = null;

  const voices: Live[] = [];
  const lastAt = new Map<CueName, number>();

  function save(): void {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* quota or sandbox */ }
  }

  function ensureContext(): boolean {
    if (ctx) return true;
    try { ctx = makeContext(); } catch { ctx = null; }
    if (!ctx) return false;
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 0;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    master = ctx.createGain();
    master.gain.value = settings.volume;
    sfxBus = ctx.createGain();
    musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_LEVEL;
    sfxBus.connect(master);
    musicBus.connect(master);
    master.connect(limiter);
    limiter.connect(ctx.destination);
    return true;
  }

  function stopPump(): void {
    if (pumpHandle !== null) { timer.clear(pumpHandle); pumpHandle = null; }
  }

  function pump(): void {
    pumpHandle = null;
    if (!ctx || !bedGain || !playingBed) return;
    const bed = BEDS[playingBed];
    const s = 60 / bed.bpm / 4;
    const now = ctx.currentTime;
    if (nextStep < now - 0.2) nextStep = now + 0.05; // after a stall, never catch up in a burst
    while (nextStep < now + LOOKAHEAD) {
      bed.play({ ctx, out: bedGain, t: nextStep, det: 1, intensity: 1, step: 0 }, stepIndex, loop, s);
      nextStep += s;
      if (++stepIndex >= bed.steps) { stepIndex = 0; loop++; }
    }
    pumpHandle = timer.set(pump, PUMP_MS);
  }

  function fadeOutBed(): void {
    if (!ctx || !bedGain) return;
    const old = bedGain;
    const now = ctx.currentTime;
    old.gain.cancelScheduledValues(now);
    old.gain.setTargetAtTime(0, now, 0.4);
    timer.set(() => old.disconnect(), 1600);
    bedGain = null;
  }

  function switchBed(bed: BedName | null): void {
    stopPump();
    fadeOutBed();
    playingBed = bed;
    if (!bed || !ctx || !musicBus) return;
    bedGain = ctx.createGain();
    const now = ctx.currentTime;
    bedGain.gain.setValueAtTime(0, now);
    bedGain.gain.linearRampToValueAtTime(1, now + 1);
    bedGain.connect(musicBus);
    stepIndex = 0;
    loop = 0;
    nextStep = now + 0.05;
  }

  /** Reconcile what is wanted (gesture, mute, visibility, bed) with what runs. */
  function sync(): void {
    const wantSound = unlocked && !settings.muted && !hidden;
    if (!wantSound) {
      stopPump();
      if (ctx && master && !suspended) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(0, ctx.currentTime);
        suspended = true;
        ctx.suspend?.().catch(() => {});
      }
      if (settings.muted) voices.length = 0;
      return;
    }
    if (!ensureContext() || !ctx || !master) return;
    if (suspended || ctx.state !== 'running') {
      suspended = false;
      ctx.resume?.().catch(() => {});
    }
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.01);
    const wantBed = settings.musicOn ? bedIntent : null;
    if (wantBed !== playingBed) switchBed(wantBed);
    if (playingBed && pumpHandle === null) pump();
  }

  function prune(now: number): void {
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].endsAt <= now) {
        for (const n of voices[i].nodes) n.disconnect();
        voices.splice(i, 1);
      }
    }
  }

  function steal(v: Live, now: number): void {
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + 0.02);
    timer.set(() => { for (const n of v.nodes) n.disconnect(); }, 40);
    voices.splice(voices.indexOf(v), 1);
  }

  function duck(now: number): void {
    if (!musicBus) return;
    const p = musicBus.gain;
    p.cancelScheduledValues(now);
    p.setTargetAtTime(MUSIC_LEVEL * DUCK, now, 0.02);
    p.setTargetAtTime(MUSIC_LEVEL, now + DUCK_HOLD, 0.12);
  }

  function play(name: CueName, opts: PlayOptions = {}): boolean {
    // Muted, hidden or before a gesture: return before touching Web Audio at all.
    if (settings.muted || hidden || !unlocked || !ctx || !sfxBus) return false;
    const cue = CUES[name];
    if (!cue) return false;
    const now = ctx.currentTime;
    prune(now);
    if (now - (lastAt.get(name) ?? -Infinity) < cue.gap) return false;
    if (voices.filter(v => v.cue === name).length >= cue.cap) return false;
    if (voices.length >= MAX_VOICES) {
      let victim: Live | null = null;
      for (const v of voices) if (v.prio < cue.prio && (!victim || v.prio < victim.prio)) victim = v;
      if (!victim) return false;
      steal(victim, now);
    }

    const gain = ctx.createGain();
    gain.gain.value = Math.pow(10, ((random() * 2 - 1) * 1.5) / 20); // ±1.5 dB
    const nodes: ANode[] = [gain];
    const pan = clamp(finite(opts.pan, 0), -1, 1);
    const panner = pan !== 0 ? ctx.createStereoPanner?.() : undefined;
    if (panner) {
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(sfxBus);
      nodes.push(panner);
    } else {
      gain.connect(sfxBus);
    }
    const t = now + 0.005;
    const dur = cue.render({
      ctx, out: gain, t,
      det: Math.pow(2, ((random() * 2 - 1) * 25) / 1200), // ±25 cents
      intensity: clamp(finite(opts.intensity, 0.5), 0, 1),
      step: finite(opts.step, 0),
    });
    voices.push({ cue: name, prio: cue.prio, endsAt: t + dur, nodes, gain });
    lastAt.set(name, now);
    if (cue.prio >= 2) duck(now);
    return true;
  }

  const onGesture = () => {
    for (const type of GESTURES) target?.removeEventListener(type, onGesture, { capture: true });
    if (unlocked) return;
    unlocked = true;
    sync();
  };
  const onVisibility = () => { hidden = doc?.hidden ?? false; sync(); };

  for (const type of GESTURES) target?.addEventListener(type, onGesture, { capture: true });
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    play,
    music(bed) {
      bedIntent = bed && bed in BEDS ? bed : null;
      sync();
    },
    setMuted(muted) {
      settings.muted = muted === true;
      save();
      sync();
    },
    setVolume(volume) {
      settings.volume = clamp(finite(volume, settings.volume), 0, 1);
      save();
      if (ctx && master && !settings.muted && !hidden) master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.02);
    },
    setMusicOn(on) {
      settings.musicOn = on === true;
      save();
      sync();
    },
    unlock: onGesture,
    get state(): AudioState {
      return {
        ...settings, unlocked, contextCreated: ctx !== null,
        running: ctx !== null && !suspended && !settings.muted && !hidden,
        bed: bedIntent, playingBed, voices: voices.length,
      };
    },
    get context() { return ctx; },
    get output() { return limiter; },
    dispose() {
      for (const type of GESTURES) target?.removeEventListener(type, onGesture, { capture: true });
      doc?.removeEventListener('visibilitychange', onVisibility);
      stopPump();
      voices.length = 0;
      ctx?.close?.().catch(() => {});
      ctx = null;
    },
  };
}

let shared: SharedAudio | null = null;

/** The page's one audio instance, created on first use. */
export function sharedAudio(): SharedAudio {
  return (shared ??= createAudio());
}
