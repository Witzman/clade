// The slice of Web Audio this module uses, written structurally.
//
// Two reasons not to name the DOM's own types here: the node typecheck
// (tsconfig.json) has no DOM lib, and tests/audio.test.ts drives the engine
// with a counting fake that implements exactly this surface — so "muted does no
// work" is asserted as "not one node was created", without a browser.

export interface AParam {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, constant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface ANode {
  connect(destination: ANode | AParam): unknown;
  disconnect(): void;
}

export interface AGain extends ANode { gain: AParam }

export interface AOsc extends ANode {
  type: string;
  frequency: AParam;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface ABuffer { getChannelData(channel: number): Float32Array }

export interface ASource extends ANode {
  buffer: ABuffer | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface AFilter extends ANode { type: string; frequency: AParam; Q: AParam }

export interface APanner extends ANode { pan: AParam }

export interface ACompressor extends ANode {
  threshold: AParam; knee: AParam; ratio: AParam; attack: AParam; release: AParam;
}

/** An AudioContext or an OfflineAudioContext. */
export interface ACtx {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: ANode;
  createGain(): AGain;
  createOscillator(): AOsc;
  createBufferSource(): ASource;
  createBuffer(channels: number, length: number, sampleRate: number): ABuffer;
  createBiquadFilter(): AFilter;
  createStereoPanner?(): APanner;
  createDynamicsCompressor(): ACompressor;
  resume?(): Promise<void>;
  suspend?(): Promise<void>;
  close?(): Promise<void>;
}
