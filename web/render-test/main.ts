// /render-test: bake 24 creatures from genomes nobody authored at 128 px, draw
// them as 48 px silhouettes, and print what it cost on this device. The number
// that matters is the one read off a real iPad, not the one from a desktop.
//
// The genomes are founded and bred with core/, the same code the game runs, and
// drawn through render/traits.ts (workshop issue #26): genome -> traits ->
// anatomy -> bake. Nothing on this page picks a trait by hand.

import { breed, founder, int, rng, type Genome } from '../../core/index.ts';
import type { AnatomyTraits } from '../../render/anatomy.ts';
import { bakeNow, type Baked } from '../../render/bake.ts';
import { loadMaterials } from '../../render/materials.ts';
import { drawSilhouette, silhouette, type Silhouette } from '../../render/silhouette.ts';
import { traits } from '../../render/traits.ts';

const BIG = 128;
const SMALL = 48;
/** Founders in the pool, how many children are bred from it, and what is shown. */
const FOUNDERS = 40;
const BRED = 400;
const SHOW_FOUNDERS = 8;
const SHOW_BRED = 16;
const COUNT = SHOW_FOUNDERS + SHOW_BRED;

// --- page -------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;

function canvas(css: number, dpr: number, title: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(css * dpr);
  c.height = Math.round(css * dpr);
  c.style.width = `${css}px`;
  c.style.height = `${css}px`;
  c.title = title;
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

  // A pool of founders, then children of random pairs from the growing pool, so
  // later children descend from earlier ones. Shown: the first founders and the
  // last children bred.
  const tPop = performance.now();
  const r = rng(base);
  const pool: Genome[] = [];
  for (let i = 0; i < FOUNDERS; i++) pool.push(founder(r));
  for (let i = 0; i < BRED; i++) pool.push(breed(pool[int(r, pool.length)], pool[int(r, pool.length)], r).child);
  const popMs = performance.now() - tPop;
  const shown = [
    ...pool.slice(0, SHOW_FOUNDERS).map((g, i) => ({ g, title: `founder ${i + 1}` })),
    ...pool.slice(pool.length - SHOW_BRED).map((g, i) => ({ g, title: `bred child ${BRED - SHOW_BRED + i + 1} of ${BRED}` })),
  ];

  const tTraits = performance.now();
  const tr: AnatomyTraits[] = shown.map((s) => traits(s.g));
  const traitsMs = performance.now() - tTraits;

  const tLoad = performance.now();
  await loadMaterials('/assets/materials/');
  const loadMs = performance.now() - tLoad;

  // Sequential, so one bake's time is not another's.
  const baked: Baked[] = [];
  const cells: HTMLCanvasElement[] = [];
  for (let i = 0; i < COUNT; i++) {
    baked.push(await bakeNow(tr[i], Math.round(BIG * dpr)));
    const c = canvas(BIG, dpr, shown[i].title);
    cells.push(c);
    $('baked').append(c);
  }

  // Blit: what a frame of 24 baked creatures costs. Median of 30 repeats.
  const blits: number[] = [];
  for (let k = 0; k < 30; k++) {
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
  for (const t of tr) sils.push(silhouette(t, SMALL));
  const buildMs = performance.now() - tBuild;
  const draws: number[] = [];
  for (const ground of ['sil-paper', 'sil-slate']) {
    const t0 = performance.now();
    sils.forEach((s, i) => {
      const c = canvas(SMALL, dpr, shown[i].title);
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);
      drawSilhouette(g, s, 0, 0);
      $(ground).append(c);
    });
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
    `creatures    ${SHOW_FOUNDERS} founders + last ${SHOW_BRED} of ${BRED} bred from ${FOUNDERS} founders`,
    ``,
    `found ${FOUNDERS} + breed ${BRED} genomes  ${ms(popMs)}`,
    `traits() x${COUNT}                ${ms(traitsMs)}`,
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
