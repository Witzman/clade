// /render-test: bake 24 unauthored creatures at 128 px, draw them as 48 px
// silhouettes, and print what it cost on this device. The number that matters
// is the one read off a real iPad, not the one from a desktop.

import type { AnatomyTraits } from '../../render/anatomy.ts';
import { bakeNow, type Baked } from '../../render/bake.ts';
import { loadMaterials } from '../../render/materials.ts';
import { drawSilhouette, silhouette, type Silhouette } from '../../render/silhouette.ts';

const COUNT = 24;
const BIG = 128;
const SMALL = 48;

// --- TEMPORARY trait generator ----------------------------------------------
// Stands in for render/traits.ts (workshop issue #26) until it lands. It draws
// every trait uniformly over its range, like the #22 experiment's
// `unauthored(seed)`: no genome, no authored mapping, deliberately.

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unauthored(seed: number): AnatomyTraits {
  const f = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(f() * (hi - lo + 1));
  const choice = <T>(xs: readonly T[]) => xs[Math.floor(f() * xs.length)];
  return {
    head: { length: f(), depth: f(), gape: f(), fringe: f(), horn: f(), eyes: int(1, 4), eyeSize: f(), stalks: f() },
    core: { length: f(), height: f(), segments: int(2, 9), chitin: f(), dorsal: f(), hunch: f() },
    limbs: { count: choice([2, 4, 6, 8]), length: f(), joints: int(2, 4), thickness: f(), foot: f(), splay: f() },
    tail: { length: f(), count: int(1, 6), sting: f() },
    size: choice([0, 0.25, 0.5, 0.75, 1]),
    hue: f(),
    pattern: f(),
    seed: seed & 0xffff,
  };
}

// --- page -------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;

function canvas(css: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(css * dpr);
  c.height = Math.round(css * dpr);
  c.style.width = `${css}px`;
  c.style.height = `${css}px`;
  return c;
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, mean: sum / s.length, median: s[Math.floor(s.length / 2)], max: s[s.length - 1], sum };
};
const ms = (x: number) => `${x.toFixed(1).padStart(6)} ms`;

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const base = Number(params.get('seed')) >>> 0 || (Math.random() * 0xffffffff) >>> 0;
  $('seedinfo').textContent = `seed ${base}`;
  ($('reroll') as HTMLAnchorElement).href = `?seed=${(Math.random() * 0xffffffff) >>> 0}`;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const traits = Array.from({ length: COUNT }, (_, i) => unauthored((base + i * 7919) >>> 0));

  const tLoad = performance.now();
  await loadMaterials('/assets/materials/');
  const loadMs = performance.now() - tLoad;

  // Sequential, so one bake's time is not another's.
  const baked: Baked[] = [];
  const cells: HTMLCanvasElement[] = [];
  for (const t of traits) {
    baked.push(await bakeNow(t, Math.round(BIG * dpr)));
    const c = canvas(BIG, dpr);
    cells.push(c);
    $('baked').append(c);
  }

  // Blit: what a frame of 24 baked creatures costs. Median of 30 repeats.
  const blits: number[] = [];
  for (let r = 0; r < 30; r++) {
    const t0 = performance.now();
    for (let i = 0; i < COUNT; i++) {
      const g = cells[i].getContext('2d')!;
      g.clearRect(0, 0, cells[i].width, cells[i].height);
      g.drawImage(baked[i].bitmap, 0, 0);
    }
    blits.push(performance.now() - t0);
  }

  // Silhouettes: build the Path2D, then draw on both grounds.
  const sils: Silhouette[] = [];
  const tBuild = performance.now();
  for (const t of traits) sils.push(silhouette(t, SMALL));
  const buildMs = performance.now() - tBuild;
  const draws: number[] = [];
  for (const ground of ['sil-paper', 'sil-slate']) {
    const t0 = performance.now();
    for (const s of sils) {
      const c = canvas(SMALL, dpr);
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);
      drawSilhouette(g, s, 0, 0);
      $(ground).append(c);
    }
    draws.push(performance.now() - t0);
  }

  const all = stats(baked.map((b) => b.ms));
  const warm = stats(baked.slice(1).map((b) => b.ms));
  const stage = (k: keyof Baked['stages']) => stats(baked.slice(1).map((b) => b.stages[k])).median;
  const blit = stats(blits);
  const lines = [
    `device       ${navigator.userAgent}`,
    `viewport     ${innerWidth}x${innerHeight} css px, devicePixelRatio ${window.devicePixelRatio}`,
    `bake size    ${BIG} css px x ${dpr} = ${Math.round(BIG * dpr)} px square`,
    ``,
    `swatch load                   ${ms(loadMs)}`,
    `first bake (cold: JIT, tiles) ${ms(baked[0].ms)}`,
    `bake, other ${warm.n}  median      ${ms(warm.median)}   mean ${ms(warm.mean)}   max ${ms(warm.max)}`,
    `  stages (median)  geometry ${ms(stage('geometry'))}  shade field ${ms(stage('field'))}  material ${ms(stage('material'))}`,
    `                   ink      ${ms(stage('ink'))}  bitmap      ${ms(stage('bitmap'))}`,
    `all ${all.n} bakes, total          ${ms(all.sum)}`,
    ``,
    `blit ${COUNT} bitmaps (a frame)   median ${ms(blit.median)}   max ${ms(blit.max)}   (30 repeats)`,
    `silhouette Path2D x${COUNT} build  ${ms(buildMs)}`,
    `silhouette draw x${COUNT}, paper   ${ms(draws[0])}`,
    `silhouette draw x${COUNT}, slate   ${ms(draws[1])}`,
  ];
  $('timings').textContent = lines.join('\n');
  document.body.dataset.done = '1';
  (window as unknown as { renderTest: unknown }).renderTest = { base, dpr, bakes: baked.map((b) => b.ms), blit, lines };
}

run().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const el = $('error');
  el.textContent = `Render test failed: ${msg}`;
  el.hidden = false;
  $('timings').textContent = 'failed';
  console.error(e);
});
