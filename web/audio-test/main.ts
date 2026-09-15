// /audio-test: every shared cue and bed, with mute, volume and a meter, plus
// checks a browser can run without anyone listening. A headless run reads
// `window.audioTest` (see the results object) for the same numbers the page
// prints.

import {
  BEDS, BED_NAMES, CUES, CUE_NAMES, MUSIC_LEVEL, sharedAudio, type ACtx, type BedName, type CueName,
} from '../../audio/index.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = sharedAudio();
const results: Record<string, unknown> = {};

// ---- meter -----------------------------------------------------------------

let analyser: AnalyserNode | null = null;
let meterData: Float32Array<ArrayBuffer> | null = null;
let heldPeak = 0;

function attachMeter(): void {
  const ctx = audio.context as unknown as AudioContext | null;
  const out = audio.output as unknown as AudioNode | null;
  if (analyser || !ctx || !out) return;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  meterData = new Float32Array(analyser.fftSize);
  out.connect(analyser);
}

function readPeak(): number {
  if (!analyser || !meterData) return 0;
  analyser.getFloatTimeDomainData(meterData);
  let p = 0;
  for (let i = 0; i < meterData.length; i++) p = Math.max(p, Math.abs(meterData[i]));
  return p;
}

const dbfs = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fmtDb = (x: number) => (Number.isFinite(dbfs(x)) ? `${dbfs(x).toFixed(1)} dB` : '–∞ dB');

// A timer rather than requestAnimationFrame: it keeps sampling in a background
// or headless tab, and the checks below depend on it.
setInterval(() => {
  const p = readPeak();
  heldPeak = Math.max(heldPeak, p);
  ($('meter').firstElementChild as HTMLElement).style.width = `${Math.min(100, p * 100)}%`;
  $('db').textContent = fmtDb(p);
  $('state').textContent = JSON.stringify(audio.state, null, 1);
}, 10);

// ---- controls --------------------------------------------------------------

function refreshControls(): void {
  const s = audio.state;
  $('mute').setAttribute('aria-pressed', String(s.muted));
  $('mute').textContent = s.muted ? 'Muted' : 'Mute';
  $('music-on').setAttribute('aria-pressed', String(s.musicOn));
  $('music-on').textContent = s.musicOn ? 'Music on' : 'Music off';
  $<HTMLInputElement>('volume').value = String(s.volume);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#beds button')) {
    b.setAttribute('aria-pressed', String((b.dataset.bed || null) === s.bed));
  }
}

$('start').addEventListener('click', () => { audio.unlock(); attachMeter(); refreshControls(); });
$('mute').addEventListener('click', () => { audio.setMuted(!audio.state.muted); attachMeter(); refreshControls(); });
$('music-on').addEventListener('click', () => { audio.setMusicOn(!audio.state.musicOn); refreshControls(); });
$('volume').addEventListener('input', e => audio.setVolume(Number((e.target as HTMLInputElement).value)));

const opts = () => ({
  intensity: Number($<HTMLInputElement>('intensity').value),
  pan: Number($<HTMLInputElement>('pan').value),
});

for (const name of CUE_NAMES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.cue = name;
  let step = 0;
  b.addEventListener('click', () => { attachMeter(); audio.play(name, { ...opts(), step: step++ }); });
  $('cues').append(b);
}
for (const name of BED_NAMES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.bed = name;
  $('beds').prepend(b);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#beds button')) {
  b.addEventListener('click', () => { attachMeter(); audio.music((b.dataset.bed || null) as BedName | null); refreshControls(); });
}

// ---- checks ----------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const report = () => { $('results').textContent = JSON.stringify(results, null, 1); };

/** Play each cue on its own, bed stopped, and record its output peak. */
async function peaks(): Promise<Record<string, number>> {
  attachMeter();
  const bed = audio.state.bed;
  audio.music(null);
  await sleep(1800); // the bed's fade-out
  const out: Record<string, number> = {};
  for (const name of CUE_NAMES) {
    heldPeak = 0;
    audio.play(name, { intensity: 0.8, step: 1 });
    await sleep(Math.round(CUES[name].length * 1000) + 120);
    out[name] = Number(dbfs(heldPeak).toFixed(1));
  }
  audio.music(bed);
  return out;
}

$('check-all').addEventListener('click', async () => {
  results.cuePeaksDb = 'running';
  report();
  const p = await peaks();
  results.cuePeaksDb = p;
  results.silentCues = Object.entries(p).filter(([, db]) => !(db > -50)).map(([n]) => n);

  // Beds: each for 3 s, peak read off the output.
  const bedPeaks: Record<string, number> = {};
  for (const name of BED_NAMES) {
    audio.music(name);
    await sleep(1500);
    heldPeak = 0;
    await sleep(2500);
    bedPeaks[name] = Number(dbfs(heldPeak).toFixed(1));
  }
  audio.music(null);
  results.bedPeaksDb = bedPeaks;
  results.checkAllDone = true;
  report();
});

$('check-muted').addEventListener('click', async () => {
  const ctx = audio.context as unknown as AudioContext | null;
  const wasMuted = audio.state.muted;
  audio.setMuted(true);
  refreshControls();
  // Count every node created on the context while muted.
  let created = 0;
  const restore: (() => void)[] = [];
  if (ctx) {
    for (const m of ['createGain', 'createOscillator', 'createBufferSource', 'createBiquadFilter', 'createStereoPanner'] as const) {
      const original = ctx[m];
      (ctx as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => { created++; return (original as (...x: unknown[]) => unknown).apply(ctx, a); };
      restore.push(() => { (ctx as unknown as Record<string, unknown>)[m] = original; });
    }
  }
  await sleep(200);
  heldPeak = 0;
  let accepted = 0;
  for (const name of CUE_NAMES) if (audio.play(name, { intensity: 1 })) accepted++;
  audio.music('tense');
  await sleep(1500);
  results.muted = {
    playAccepted: accepted, nodesCreated: created, peakDb: dbfs(heldPeak),
    contextState: ctx?.state ?? 'none', rememberedAs: localStorage.getItem('clade.audio'),
  };
  audio.music(null);
  for (const r of restore) r();
  audio.setMuted(wasMuted);
  refreshControls();
  results.checkMutedDone = true;
  report();
});

$('stress').addEventListener('click', async () => {
  attachMeter();
  // Eight players, each firing a random cue every ~125 ms for 2 s: 128 events,
  // many landing in the same frame.
  const times: number[] = [];
  let accepted = 0;
  let maxVoices = 0;
  let clipped = 0;
  const end = performance.now() + 2000;
  while (performance.now() < end) {
    for (let p = 0; p < 8; p++) {
      const name = CUE_NAMES[Math.floor(Math.random() * CUE_NAMES.length)] as CueName;
      const t0 = performance.now();
      if (audio.play(name, { intensity: Math.random(), pan: p / 3.5 - 1, step: p })) accepted++;
      times.push(performance.now() - t0);
      maxVoices = Math.max(maxVoices, audio.state.voices);
    }
    if (readPeak() >= 0.999) clipped++;
    await sleep(125);
  }
  times.sort((a, b) => a - b);
  results.burst = {
    events: times.length, accepted, dropped: times.length - accepted, maxVoices, framesAtFullScale: clipped,
    playMsMedian: Number(times[Math.floor(times.length / 2)].toFixed(3)), playMsMax: Number(times[times.length - 1].toFixed(3)),
  };
  results.burstDone = true;
  report();
});

$('bench').addEventListener('click', async () => {
  const seconds = 10;
  const rate = 44100;
  const off = new OfflineAudioContext(2, seconds * rate, rate);
  const ctx = off as unknown as ACtx;
  const bus = off.createGain();
  bus.connect(off.destination);
  const musicBus = off.createGain();
  musicBus.gain.value = MUSIC_LEVEL;
  musicBus.connect(off.destination);
  const bed = BEDS.tense;
  const s = 60 / bed.bpm / 4;
  const tSched = performance.now();
  for (let i = 0, t = 0; t < seconds; i++, t += s) {
    bed.play({ ctx, out: musicBus as unknown as ACtx['destination'], t, det: 1, intensity: 1, step: 0 }, i % bed.steps, Math.floor(i / bed.steps), s);
  }
  // A stress load on top: 8 cues per second, every cue in turn.
  let n = 0;
  for (let t = 0.1; t < seconds - 1.2; t += 0.125, n++) {
    const name = CUE_NAMES[n % CUE_NAMES.length];
    CUES[name].render({ ctx, out: bus as unknown as ACtx['destination'], t, det: 1, intensity: 0.7, step: n });
  }
  const scheduleMs = performance.now() - tSched;
  const t0 = performance.now();
  await off.startRendering();
  const renderMs = performance.now() - t0;
  results.offline = {
    audioSeconds: seconds, cues: n, scheduleMs: Number(scheduleMs.toFixed(1)), renderMs: Number(renderMs.toFixed(1)),
    timesRealtime: Number(((seconds * 1000) / renderMs).toFixed(1)),
  };
  results.benchDone = true;
  report();
});

refreshControls();
(window as unknown as { audioTest: unknown }).audioTest = { audio, results };
