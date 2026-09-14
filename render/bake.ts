// Polygons + materials + shade field -> ImageBitmap, once per creature.
//
// Port of the #22 experiment's hybrid renderer. Bake once at birth, blit
// forever: a bake costs tens of milliseconds on a slow tablet, a blit of a
// baked bitmap costs almost nothing.
//
// The Python shades with a Gaussian blur. `ctx.filter` would do that in one
// line, but Safari ships it disabled on every platform, iPadOS included — so
// the shade field is a JS separable box blur (three passes approximate a
// Gaussian) on a reduced-resolution mask. The cast shadow's soft edge uses
// `shadowBlur`, which Safari does support.
//
// Stacking, bottom to top, exactly as the Python composites it:
//   cast shadow, outer ink ring, material body, part contours, eyes.

import { scaled, type AnatomyTraits, type Anatomy } from './anatomy.ts';
import { ctx2d, makeCanvas, trace, type Ctx2D } from './canvas.ts';
import { pick, tile, TILE_SCALE, type Material } from './materials.ts';
import { INK, css, familyFor, mix, type RGB } from './palette.ts';

/** The Python renders 3x supersampled; geometry constants assume that scale. */
const SS = 3;
const LIGHT_X = -0.55, LIGHT_Y = -0.83;

export interface BakeStages {
  geometry: number;
  field: number;
  material: number;
  ink: number;
  bitmap: number;
}

export interface Baked {
  bitmap: ImageBitmap;
  /** Bake size in device pixels. */
  px: number;
  ms: number;
  stages: BakeStages;
}

// --- the shade field --------------------------------------------------------

/** Box widths whose three passes approximate a Gaussian of `sigma`. */
function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i < m ? wl : wu);
  return out;
}

/** One running-sum box pass along rows (dx=1) or columns, edges clamped. */
function boxPass(src: Float32Array, dst: Float32Array, W: number, H: number, r: number, horizontal: boolean): void {
  const inv = 1 / (2 * r + 1);
  const lines = horizontal ? H : W;
  const len = horizontal ? W : H;
  const step = horizontal ? 1 : W;
  for (let l = 0; l < lines; l++) {
    const o = horizontal ? l * W : l;
    const first = src[o], last = src[o + (len - 1) * step];
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[o + Math.min(j, len - 1) * step];
    for (let i = 0; i < len; i++) {
      const add = i + r < len ? src[o + (i + r) * step] : last;
      acc += add;
      dst[o + i * step] = acc * inv;
      const sub = i - r >= 0 ? src[o + (i - r) * step] : first;
      acc -= sub;
    }
  }
}

function gaussBlur(f: Float32Array, W: number, H: number, sigma: number): void {
  const tmp = new Float32Array(f.length);
  for (const w of boxesForGauss(sigma)) {
    const r = (w - 1) >> 1;
    if (r < 1) continue;
    boxPass(f, tmp, W, H, r, true);
    boxPass(tmp, f, W, H, r, false);
  }
}

/** Exact Euclidean distance to the nearest background pixel (Felzenszwalb). */
function edt(solid: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20;
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float64Array(W * H);
  for (let i = 0; i < grid.length; i++) grid[i] = solid[i] ? INF : 0;
  const pass1d = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
    pass1d(H);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x];
    pass1d(W);
    for (let x = 0; x < W; x++) grid[y * W + x] = d[x];
  }
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/**
 * 0 = lit, 1 = deep shadow, NOT multiplied by the mask (the caller's part
 * masks do that at full resolution, which keeps the edges crisp).
 *
 * Blurring a flat mask and taking its gradient gives a normal that points into
 * the shape and tilts with its curvature — enough to light a silhouette as if
 * it had a body.
 */
function shadeField(solid: Uint8Array, Q: number, blur: number): Float32Array {
  const f = new Float32Array(Q * Q);
  for (let i = 0; i < f.length; i++) f[i] = solid[i];
  gaussBlur(f, Q, Q, blur);
  const dist = edt(solid, Q, Q);
  const lam = new Float32Array(Q * Q);
  const innerDiv = blur * 2.2;
  for (let y = 0; y < Q; y++) {
    for (let x = 0; x < Q; x++) {
      const i = y * Q + x;
      // np.gradient: central differences inside, one-sided at the borders
      const gx = x === 0 ? f[i + 1] - f[i] : x === Q - 1 ? f[i] - f[i - 1] : (f[i + 1] - f[i - 1]) / 2;
      const gy = y === 0 ? f[i + Q] - f[i] : y === Q - 1 ? f[i] - f[i - Q] : (f[i + Q] - f[i - Q]) / 2;
      const n = Math.sqrt(gx * gx + gy * gy) + 1e-6;
      let l = 0.5 - 0.5 * ((gx / n) * LIGHT_X + (gy / n) * LIGHT_Y);
      l = l < 0 ? 0 : l > 1 ? 1 : l;
      // interior far from any edge settles at mid tone, not flat white
      let inner = dist[i] / innerDiv;
      inner = inner > 1 ? 1 : inner;
      l = l * (1 - inner) + 0.52 * inner;
      lam[i] = l < 0 ? 0 : l > 1 ? 1 : l;
    }
  }
  return lam;
}

/** The field's resolution: a quarter of the bake, but never so coarse the blur degenerates. */
export function fieldSize(B: number): number {
  return Math.min(B, Math.max(96, Math.ceil(B / 4)));
}

// --- the ramp --------------------------------------------------------------

const LUT_N = 1024;

/** 0..1 -> INK, shadow, base, light: the palette's four stops. */
function rampLut(fam: readonly [RGB, RGB, RGB]): Float32Array {
  const stops = [INK, fam[0], fam[1], fam[2]];
  const lut = new Float32Array((LUT_N + 1) * 3);
  for (let i = 0; i <= LUT_N; i++) {
    const pos = (i / LUT_N) * 3;
    const i0 = Math.min(Math.floor(pos), 2);
    const t = pos - i0;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[i0][c] * (1 - t) + stops[i0 + 1][c] * t;
  }
  return lut;
}

// --- the bake ----------------------------------------------------------------

function fillParts(g: Ctx2D, geo: Anatomy, k: number, only?: (i: number) => boolean): void {
  geo.parts.forEach((p, i) => {
    if (!p.closed || (only && !only(i))) return;
    g.beginPath();
    trace(g, p.pts, k, true);
    g.fill();
  });
}

/** Bake one creature at `px` device pixels square. Uncached; see `bake()`. */
export async function bakeNow(traits: AnatomyTraits, px: number): Promise<Baked> {
  const t0 = performance.now();
  const B = px;
  const S = B * SS; // geometry units, as the Python builds them
  const k = 1 / SS; // geometry -> bake pixels
  const geo = scaled(traits, S);
  const fam = familyFor(traits.hue);
  const lwGeo = Math.max(2, Math.trunc(S * 0.0026));
  const t1 = performance.now();

  // 1. one light for the whole animal
  const Q = fieldSize(B);
  const qc = makeCanvas(Q, Q);
  const qg = ctx2d(qc, true);
  qg.fillStyle = '#fff';
  fillParts(qg, geo, Q / S);
  const qa = qg.getImageData(0, 0, Q, Q).data;
  const solidQ = new Uint8Array(Q * Q);
  for (let i = 0; i < solidQ.length; i++) solidQ[i] = qa[i * 4 + 3] > 127 ? 1 : 0;
  const blurGeo = Math.max(2.0, S * 0.022);
  const lam = shadeField(solidQ, Q, (blurGeo * Q) / S);
  // FORM FIRST, MATERIAL SECOND: the shared light sets the value, the plate
  // only modulates it. Upsampled bilinearly to the bake.
  const form = new Float32Array(B * B);
  const qs = Q / B;
  for (let y = 0; y < B; y++) {
    let fy = (y + 0.5) * qs - 0.5;
    fy = fy < 0 ? 0 : fy > Q - 1 ? Q - 1 : fy;
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, Q - 1), wy = fy - y0;
    for (let x = 0; x < B; x++) {
      let fx = (x + 0.5) * qs - 0.5;
      fx = fx < 0 ? 0 : fx > Q - 1 ? Q - 1 : fx;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, Q - 1), wx = fx - x0;
      const v =
        (lam[y0 * Q + x0] * (1 - wx) + lam[y0 * Q + x1] * wx) * (1 - wy) +
        (lam[y1 * Q + x0] * (1 - wx) + lam[y1 * Q + x1] * wx) * wy;
      const fm = 0.3 + 0.62 * (1 - v);
      form[y * B + x] = fm < 0 ? 0 : fm > 1 ? 1 : fm;
    }
  }
  const t2 = performance.now();

  // 2. material body, grouped by (material, shade) in first-seen order
  const groups = new Map<string, { name: Material; shade: number; idx: number[] }>();
  geo.parts.forEach((p, i) => {
    if (!p.closed) return;
    const name = pick(traits.core.chitin, p.kind);
    const shade = Math.round(p.shade * 100) / 100;
    const key = `${name}|${shade}`;
    let grp = groups.get(key);
    if (!grp) groups.set(key, (grp = { name, shade, idx: [] }));
    grp.idx.push(i);
  });
  const tilePx = Math.max(1, Math.round(Math.max(8, Math.trunc(S * TILE_SCALE)) * k));
  const lut = rampLut(fam);
  const acc = new Float32Array(B * B * 3); // premultiplied
  const alpha = new Float32Array(B * B);
  const mc = makeCanvas(B, B);
  const mg = ctx2d(mc, true);
  mg.fillStyle = '#fff';
  for (const grp of groups.values()) {
    mg.clearRect(0, 0, B, B);
    const set = new Set(grp.idx);
    fillParts(mg, geo, k, (i) => set.has(i));
    const m = mg.getImageData(0, 0, B, B).data;
    const tex = tile(grp.name, B, tilePx);
    const sh = 0.55 + 0.45 * grp.shade;
    for (let i = 0; i < B * B; i++) {
      const a8 = m[i * 4 + 3];
      if (a8 === 0) continue;
      const a = a8 / 255;
      let t = form[i] * (0.56 + (0.8 * tex[i]) / 255) * sh;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const li = Math.round(t * LUT_N) * 3;
      const o = i * 3, ia = 1 - a;
      acc[o] = lut[li] * a + acc[o] * ia;
      acc[o + 1] = lut[li + 1] * a + acc[o + 1] * ia;
      acc[o + 2] = lut[li + 2] * a + acc[o + 2] * ia;
      alpha[i] = a + alpha[i] * ia;
    }
  }
  const body = new ImageData(B, B);
  const bd = body.data;
  for (let i = 0; i < B * B; i++) {
    const a = alpha[i];
    if (a === 0) continue;
    bd[i * 4] = acc[i * 3] / a;
    bd[i * 4 + 1] = acc[i * 3 + 1] / a;
    bd[i * 4 + 2] = acc[i * 3 + 2] / a;
    bd[i * 4 + 3] = a * 255;
  }
  const bc = makeCanvas(B, B);
  ctx2d(bc).putImageData(body, 0, 0);
  const t3 = performance.now();

  // 3. assemble: shadow, ring, body, contours, eyes
  const out = makeCanvas(B, B);
  const g = ctx2d(out);
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // cast shadow — soft edge by shadowBlur (device px, sigma = blur / 2)
  {
    const { cx, w } = geo.core;
    const x0 = (cx - w * 0.55) * k, x1 = (cx + w * 0.55) * k;
    const y0 = (geo.ground - S * 0.012) * k, y1 = (geo.ground + S * 0.016) * k;
    const off = B * 4;
    g.save();
    g.shadowColor = css(mix(INK, fam[0], 0.5), 70 / 255);
    g.shadowBlur = 2 * S * 0.006 * k;
    g.shadowOffsetX = off;
    g.fillStyle = '#000';
    g.beginPath();
    g.ellipse((x0 + x1) / 2 - off, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // one heavier ink outline round the whole animal: the union, grown
  g.fillStyle = css(INK);
  g.strokeStyle = css(INK);
  g.lineWidth = Math.max(2, Math.trunc(S / 220)) * k;
  for (const p of geo.parts) {
    if (!p.closed) continue;
    g.beginPath();
    trace(g, p.pts, k, true);
    g.fill();
    g.stroke();
  }

  g.drawImage(bc, 0, 0);

  // contours, drawn once over everything
  g.lineWidth = lwGeo * k;
  const ink = css(INK), plate = css(mix(INK, fam[0], 0.3));
  for (const p of geo.parts) {
    g.beginPath();
    trace(g, p.pts, k, p.closed);
    g.strokeStyle = p.closed ? ink : plate;
    g.stroke();
  }

  // eyes
  const light = css(fam[2]);
  for (const [ex, ey, er0] of geo.eyes) {
    const er = Math.max(er0, S * 0.005);
    g.beginPath();
    g.arc(ex * k, ey * k, er * 1.3 * k, 0, Math.PI * 2);
    g.fillStyle = light;
    g.fill();
    g.strokeStyle = ink;
    g.stroke();
    g.beginPath();
    g.arc(ex * k, ey * k, er * 0.6 * k, 0, Math.PI * 2);
    g.fillStyle = ink;
    g.fill();
  }
  const t4 = performance.now();

  const bitmap = await createImageBitmap(out);
  const t5 = performance.now();
  return {
    bitmap,
    px: B,
    ms: t5 - t0,
    stages: { geometry: t1 - t0, field: t2 - t1, material: t3 - t2, ink: t4 - t3, bitmap: t5 - t4 },
  };
}

const cache = new Map<string, Promise<Baked>>();

/**
 * Bake `traits` at `size` CSS px x `dpr`, cached by `key` — the genome hash,
 * since the picture is a pure function of the genome.
 */
export function bake(traits: AnatomyTraits, key: string, size: number, dpr = 1): Promise<Baked> {
  const px = Math.max(1, Math.round(size * dpr));
  const ck = `${key}@${px}`;
  let hit = cache.get(ck);
  if (!hit) {
    hit = bakeNow(traits, px);
    cache.set(ck, hit);
    hit.catch(() => cache.delete(ck));
  }
  return hit;
}

export function clearBakeCache(): void {
  for (const p of cache.values()) p.then((b) => b.bitmap.close(), () => {});
  cache.clear();
}
