// Tests for the shared audio module (audio/). Run: node --test tests/audio.test.ts
// (Node 22 strips the types; nothing to build.)
//
// Node has no Web Audio, so the engine is driven with a fake context that
// implements the structural surface in audio/types.ts and COUNTS every node it
// creates. That turns the guarantees into assertions without ears: "muted does
// no work" is "zero nodes created", "nothing before a gesture" is "no context
// exists". The fake also rejects what a real browser rejects (an exponential
// ramp to 0, a non-finite value, a source stopped before it starts), so a cue
// that would throw in Chrome fails here first.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEDS, BED_NAMES, CUES, CUE_NAMES, MAX_VOICES, STORAGE_KEY, createAudio, readSettings,
  type AudioOptions, type BedName, type CueName,
} from "../audio/index.ts";
import type { ACtx, ANode, AParam } from "../audio/types.ts";

// ---- fake Web Audio ---------------------------------------------------------

class Param implements AParam {
  value: number;
  events: [string, number, number][] = [];
  constructor(v = 0) { this.value = v; }
  private check(v: number, t: number) {
    assert.ok(Number.isFinite(v), `non-finite param value ${v}`);
    assert.ok(Number.isFinite(t) && t >= 0, `bad param time ${t}`);
  }
  setValueAtTime(v: number, t: number) { this.check(v, t); this.events.push(["set", v, t]); }
  linearRampToValueAtTime(v: number, t: number) { this.check(v, t); this.events.push(["lin", v, t]); }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.check(v, t);
    assert.ok(v > 0, `exponential ramp to ${v}: a browser throws RangeError`);
    this.events.push(["exp", v, t]);
  }
  setTargetAtTime(v: number, t: number, c: number) { this.check(v, t); assert.ok(c > 0); this.events.push(["target", v, t]); }
  cancelScheduledValues(t: number) { this.check(0, t); }
}

class Node implements ANode {
  outs: (ANode | AParam)[] = [];
  protected fake: FakeContext;
  constructor(fake: FakeContext) { this.fake = fake; fake.nodes++; }
  connect(d: ANode | AParam) { this.outs.push(d); }
  disconnect() { this.outs = []; this.fake.disconnects++; }
}

class Scheduled extends Node {
  startAt: number | null = null;
  stopAt: number | null = null;
  start(t = 0) { assert.equal(this.startAt, null, "started twice"); this.startAt = t; this.fake.sources.push(this); }
  stop(t = 0) {
    assert.notEqual(this.startAt, null, "stopped before started");
    assert.ok(t >= this.startAt!, "stop before start");
    this.stopAt = t;
  }
}

class FakeContext implements ACtx {
  nodes = 0;
  disconnects = 0;
  sources: Scheduled[] = [];
  currentTime = 0;
  sampleRate = 8000;
  state = "running";
  destination: ANode;
  constructor() { this.destination = new Node(this); this.nodes = 0; }
  createGain() { return Object.assign(new Node(this), { gain: new Param(1) }); }
  createOscillator() { return Object.assign(new Scheduled(this), { type: "sine", frequency: new Param(440) }); }
  createBufferSource() { return Object.assign(new Scheduled(this), { buffer: null }); }
  createBuffer(_c: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
  createBiquadFilter() { return Object.assign(new Node(this), { type: "lowpass", frequency: new Param(350), Q: new Param(1) }); }
  createStereoPanner() { return Object.assign(new Node(this), { pan: new Param(0) }); }
  createDynamicsCompressor() {
    return Object.assign(new Node(this), {
      threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param(),
    });
  }
  async resume() { this.state = "running"; }
  async suspend() { this.state = "suspended"; }
  async close() { this.state = "closed"; }
}

class FakeTarget {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: () => void) { this.listeners.get(type)?.delete(fn); }
  fire(type: string) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); }
  count() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
}

class FakeDoc extends FakeTarget { hidden = false; }

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

class ManualTimer {
  pending = new Map<number, () => void>();
  next = 1;
  set(fn: () => void) { const h = this.next++; this.pending.set(h, fn); return h; }
  clear(h: unknown) { this.pending.delete(h as number); }
  runAll() { const fns = [...this.pending.values()]; this.pending.clear(); for (const fn of fns) fn(); }
}

function rig(opts: Partial<AudioOptions> = {}) {
  const contexts: FakeContext[] = [];
  const target = new FakeTarget();
  const doc = new FakeDoc();
  const storage = new MemStorage();
  const timer = new ManualTimer();
  const audio = createAudio({
    createContext: () => { const c = new FakeContext(); contexts.push(c); return c; },
    gestureTarget: target, document: doc, storage, timer, random: () => 0.5,
    ...opts,
  });
  return { audio, contexts, target, doc, storage, timer, ctx: () => contexts[0] };
}

// ---- API surface ------------------------------------------------------------

test("the module exposes the documented API and a general-purpose set", () => {
  const { audio } = rig();
  for (const k of ["play", "music", "setMuted", "setVolume", "setMusicOn", "unlock", "dispose"] as const) {
    assert.equal(typeof audio[k], "function", k);
  }
  assert.deepEqual(CUE_NAMES, ["tap", "confirm", "cancel", "deny", "tick", "alert", "birth", "discover",
    "hit", "block", "miss", "ko", "gain", "loss", "win", "lose"]);
  assert.deepEqual(BED_NAMES, ["calm", "tense"]);
});

// ---- autoplay policy --------------------------------------------------------

test("nothing is created before a user gesture; play is dropped, music is remembered", () => {
  const { audio, contexts, target } = rig();
  assert.equal(audio.play("confirm"), false);
  audio.music("calm");
  assert.equal(contexts.length, 0, "an AudioContext before a gesture");
  assert.equal(audio.state.contextCreated, false);
  assert.equal(target.count(), 3, "pointerdown, keydown and touchend listeners");

  target.fire("pointerdown");
  assert.equal(contexts.length, 1);
  assert.equal(target.count(), 0, "gesture listeners removed after the first");
  assert.equal(audio.state.playingBed, "calm", "music asked for before the gesture starts at it");
  assert.equal(contexts[0].sources.length > 0, true, "the bed scheduled notes");
  assert.equal(audio.play("confirm"), true);
});

test("a play that arrived before the gesture is not replayed after it", () => {
  const { audio, target, ctx } = rig();
  audio.play("win");
  target.fire("keydown");
  assert.equal(ctx().sources.length, 0);
});

// ---- mute -------------------------------------------------------------------

test("muted: play does no Web Audio work at all", () => {
  const { audio, target, ctx } = rig();
  target.fire("pointerdown");
  audio.setMuted(true);
  const before = ctx().nodes;
  for (const name of CUE_NAMES) for (let i = 0; i < 20; i++) assert.equal(audio.play(name), false);
  assert.equal(ctx().nodes, before, "nodes created while muted");
  assert.equal(ctx().state, "suspended", "context suspended on mute");
});

test("muted: the music scheduler stops and schedules nothing", () => {
  const { audio, target, ctx, timer } = rig();
  target.fire("pointerdown");
  audio.music("tense");
  audio.setMuted(true);
  const before = ctx().nodes;
  ctx().currentTime += 30;
  timer.runAll();
  audio.music("calm");
  timer.runAll();
  assert.equal(ctx().nodes, before, "bed notes scheduled while muted");
  assert.equal(timer.pending.size, 0, "a timer still pending while muted");
});

test("muted before the first gesture: the gesture creates no context", () => {
  const storage = new MemStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ muted: true }));
  const { audio, contexts, target } = rig({ storage });
  audio.music("calm");
  target.fire("pointerdown");
  assert.equal(contexts.length, 0);
  audio.setMuted(false); // a click on the unmute control
  assert.equal(contexts.length, 1);
  assert.equal(audio.state.playingBed, "calm");
});

test("mute is remembered, and survives a settings shape it does not know", () => {
  const storage = new MemStorage();
  rig({ storage }).audio.setMuted(true);
  assert.equal(rig({ storage }).audio.state.muted, true);

  // A later version adds fields, or writes garbage elsewhere: still muted.
  storage.setItem(STORAGE_KEY, JSON.stringify({ muted: true, volume: "loud", musicOn: 7, schema: 9 }));
  assert.deepEqual(readSettings(storage), { muted: true, volume: 0.8, musicOn: true });
  storage.setItem(STORAGE_KEY, "{not json");
  assert.deepEqual(readSettings(storage), { muted: false, volume: 0.8, musicOn: true });
  assert.deepEqual(readSettings(null), { muted: false, volume: 0.8, musicOn: true });
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.doesNotThrow(() => rig({ storage: throwing }).audio.setMuted(true));
});

test("volume is clamped and persisted; the music switch silences only the beds", () => {
  const { audio, target, storage, ctx } = rig();
  target.fire("pointerdown");
  audio.setVolume(3);
  assert.equal(audio.state.volume, 1);
  audio.setVolume(Number.NaN);
  assert.equal(audio.state.volume, 1);
  audio.setVolume(0.25);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).volume, 0.25);

  audio.music("calm");
  audio.setMusicOn(false);
  assert.equal(audio.state.playingBed, null);
  assert.equal(audio.state.bed, "calm", "the intent is kept");
  assert.equal(audio.play("hit"), true, "cues still sound with music off");
  audio.setMusicOn(true);
  assert.equal(audio.state.playingBed, "calm");
  void ctx;
});

test("a hidden tab suspends and stops scheduling; returning resumes", () => {
  const { audio, target, doc, ctx, timer } = rig();
  target.fire("pointerdown");
  audio.music("calm");
  doc.hidden = true;
  doc.fire("visibilitychange");
  assert.equal(ctx().state, "suspended");
  assert.equal(timer.pending.size, 0);
  assert.equal(audio.play("tap"), false);
  doc.hidden = false;
  doc.fire("visibilitychange");
  assert.equal(ctx().state, "running");
  assert.equal(audio.state.running, true);
  assert.equal(timer.pending.size > 0, true);
});

// ---- the set ----------------------------------------------------------------

test("every cue renders, starts and stops every source, and ends within its declared length", () => {
  for (const name of CUE_NAMES) {
    for (const intensity of [0, 0.5, 1]) {
      const ctx = new FakeContext();
      ctx.currentTime = 2;
      const out = ctx.createGain();
      const dur = CUES[name].render({ ctx, out, t: 2, det: 1.01, intensity, step: 5 });
      assert.ok(ctx.sources.length > 0, `${name} made no sound source`);
      for (const s of ctx.sources) {
        assert.ok(s.startAt! >= 2, `${name} starts in the past`);
        assert.notEqual(s.stopAt, null, `${name} leaves a source running forever`);
        assert.ok(s.stopAt! <= 2 + dur + 1e-9, `${name} source outlives its reported duration`);
      }
      assert.ok(dur > 0 && dur <= CUES[name].length, `${name}: ${dur}s exceeds declared ${CUES[name].length}s`);
    }
  }
});

test("every bed step renders without error, and one loop stops every source", () => {
  for (const name of BED_NAMES) {
    const bed = BEDS[name as BedName];
    const ctx = new FakeContext();
    const out = ctx.createGain();
    const s = 60 / bed.bpm / 4;
    for (let loop = 0; loop < 2; loop++) {
      for (let i = 0; i < bed.steps; i++) bed.play({ ctx, out, t: 1 + (loop * bed.steps + i) * s, det: 1, intensity: 1, step: 0 }, i, loop, s);
    }
    assert.ok(ctx.sources.length > bed.steps / 4, `${name} is nearly silent`);
    for (const src of ctx.sources) assert.notEqual(src.stopAt, null, `${name} leaves a source running`);
  }
});

// ---- restraint --------------------------------------------------------------

test("the voice cap holds under a burst from many players", () => {
  const { audio, target, ctx } = rig();
  target.fire("pointerdown");
  let peak = 0;
  let accepted = 0;
  // Every cue in every 10 ms frame for 2 s: 3200 events, far past the cap.
  for (let frame = 0; frame < 200; frame++) {
    ctx().currentTime = 1 + frame * 0.01;
    for (const [i, name] of CUE_NAMES.entries()) {
      if (audio.play(name, { intensity: (i % 10) / 10, pan: (i % 3) - 1, step: frame })) accepted++;
      peak = Math.max(peak, audio.state.voices);
      assert.ok(audio.state.voices <= MAX_VOICES, `voices ${audio.state.voices} > ${MAX_VOICES}`);
    }
  }
  assert.equal(peak, MAX_VOICES, "the burst never reached the cap, so the cap was not tested");
  assert.ok(accepted < 3200 / 4, `accepted ${accepted} of 3200`);
});

test("a retrigger inside a cue's gap is one sound; a cue's own cap holds", () => {
  const { audio, target, ctx } = rig();
  target.fire("pointerdown");
  ctx().currentTime = 1;
  assert.equal(audio.play("tap"), true);
  assert.equal(audio.play("tap"), false, "same frame");
  ctx().currentTime = 1 + CUES.tap.gap + 0.001;
  assert.equal(audio.play("tap"), true);
  ctx().currentTime += CUES.tap.gap + 0.001;
  assert.equal(audio.play("tap"), false, "cap of 2 concurrent taps");
});

test("at the cap, an outcome steals a routine voice; a routine cue never steals", () => {
  const { audio, target, ctx } = rig();
  target.fire("pointerdown");
  // Twelve voices, every one still sounding at t = 1.143 (the shortest ends at
  // 1.165): exactly two of priority 0 (the cancels), none lower than 1 otherwise.
  const at = (t: number, cues: CueName[]) => {
    ctx().currentTime = t;
    for (const c of cues) assert.equal(audio.play(c), true, `${c} at ${t}`);
  };
  at(1.0, ["birth", "hit", "alert", "confirm", "cancel"]);
  at(1.071, ["birth", "hit", "discover", "confirm", "cancel"]);
  at(1.142, ["birth", "hit"]);
  assert.equal(audio.state.voices, MAX_VOICES);
  const fill: CueName[] = ["birth", "hit", "alert", "confirm", "cancel", "discover"];
  assert.equal(fill.filter(c => c !== "cancel").every(c => CUES[c].prio >= 1), true);
  assert.equal(CUES.cancel.prio, 0);

  ctx().currentTime = 1.143;
  assert.equal(audio.play("tap"), false, "priority 0 has nothing lower to steal");
  assert.equal(audio.play("win"), true, "priority 3 steals a cancel");
  assert.equal(audio.play("block"), true, "priority 1 steals the other cancel");
  assert.equal(audio.play("tick"), false, "priority 1 may not steal an equal priority");
  assert.equal(audio.state.voices, MAX_VOICES);
});

test("dispose removes every listener and stops the scheduler", () => {
  const { audio, target, doc, timer } = rig();
  target.fire("pointerdown");
  audio.music("tense");
  audio.dispose();
  assert.equal(target.count(), 0);
  assert.equal(doc.count(), 0);
  assert.equal(timer.pending.size <= 1, true); // at most the old bed's fade-out disconnect
});

test("without Web Audio the module is a silent no-op, never an error", () => {
  const { audio, target } = rig({ createContext: () => null });
  target.fire("pointerdown");
  audio.music("calm");
  assert.equal(audio.play("win"), false);
  assert.equal(audio.state.contextCreated, false);
});
