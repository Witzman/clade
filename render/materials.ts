// Commons plates used as MATERIAL, not as parts.
//
// A cut-out of a lion's head is indexed by species, so an offspring whose head
// nobody authored has nothing to look up. A swatch of lion fur is indexed by a
// number — how hard the hide is — and every creature has that number. So the
// surface is chosen by `core.chitin`, never by a name, and nothing here can
// fail to find a texture.
//
// The swatches are greyscale, seamless, tone-normalised PNGs in
// assets/materials/; their provenance is in CREDITS.md. Port of the #22
// experiment's `materials.pick` and `materials.tile`.

import type { PartKind } from './anatomy.ts';
import { ctx2d, makeCanvas, type AnyCanvas } from './canvas.ts';

/** Ordered soft -> hard; `pick()` indexes this by the chitin trait. */
export const MATERIALS = ['hide', 'fur', 'membrane', 'scute', 'chitin'] as const;
export type Material = (typeof MATERIALS)[number];

/** Trait number -> surface. No species anywhere in this function. */
export function pick(chitin: number, kind: PartKind): Material {
  const c = Number.isFinite(chitin) ? Math.min(Math.max(chitin, 0), 0.999) : 0;
  let i = Math.trunc(c * MATERIALS.length);
  if (kind === 'fringe') i = Math.min(i, 1); // a fringe is always hair-like
  if (kind === 'jaw' || kind === 'horn' || kind === 'foot') i = Math.max(i, 3); // keratin/bone is hard
  return MATERIALS[i];
}

/**
 * The swatch's on-screen size as a fraction of the canvas. Get this wrong and
 * the material reads as abstract pattern rather than as a surface.
 */
export const TILE_SCALE = 0.062;

const swatches = new Map<Material, HTMLImageElement>();

/** Load every swatch once. `base` is a URL prefix ending in '/'. */
export async function loadMaterials(base: string): Promise<void> {
  await Promise.all(
    MATERIALS.map(async (name) => {
      if (swatches.has(name)) return;
      const img = new Image();
      img.src = `${base}${name}.png`;
      await img.decode();
      swatches.set(name, img);
    }),
  );
}

export function materialsLoaded(): boolean {
  return swatches.size === MATERIALS.length;
}

/** Downscale by repeated halving: one bilinear step from 384 px to 30 px aliases. */
function shrink(src: HTMLImageElement, px: number): AnyCanvas {
  let cur: CanvasImageSource = src;
  let w = src.naturalWidth;
  while (Math.floor(w / 2) >= px) {
    const nw = Math.floor(w / 2);
    const c = makeCanvas(nw, nw);
    const g = ctx2d(c);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nw);
    cur = c;
    w = nw;
  }
  const out = makeCanvas(px, px);
  const g = ctx2d(out);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, px, px);
  return out;
}

const tiles = new Map<string, Uint8Array>();

/**
 * The swatch repeated across a B x B bake, as one grey byte per pixel.
 * `px` is the swatch's tile size in bake pixels.
 */
export function tile(name: Material, B: number, px: number): Uint8Array {
  const key = `${name}|${B}|${px}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  const src = swatches.get(name);
  if (!src) throw new Error(`material ${name} not loaded — call loadMaterials() first`);
  const c = makeCanvas(B, B);
  const g = ctx2d(c, true);
  const pattern = g.createPattern(shrink(src, px), 'repeat');
  if (!pattern) throw new Error('createPattern failed');
  g.fillStyle = pattern;
  g.fillRect(0, 0, B, B);
  const rgba = g.getImageData(0, 0, B, B).data;
  const grey = new Uint8Array(B * B);
  for (let i = 0; i < grey.length; i++) grey[i] = rgba[i * 4];
  tiles.set(key, grey);
  return grey;
}
