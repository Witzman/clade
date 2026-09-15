// The creature card every variant shows: the picture, the derived name, the
// size class, where the creature came from, and (for a young one) its birth
// lines. Workshop issue #61. Presentation of core/ only; it holds no rules.
//
//   const { element, ready } = creatureCard(genome, { tag: 'young', lines: birthSentences(fusions) });
//
// The picture is drawn from the genome alone, through render/: a baked bitmap
// at card size, and above SILHOUETTE_MAX the silhouette instead, because at
// 48 px or less a creature IS its silhouette (render/silhouette.ts). Colours
// come from render/palette.ts and nowhere else.
//
// Browser-only (DOM, canvas). DOM-free wording lives in ui/words.ts and
// ui/birth.ts so the node tests can load it.

import { FORMS, express, label, type Genome } from '../core/index.ts';
import { bake } from '../render/bake.ts';
import { loadMaterials } from '../render/materials.ts';
import { ACCENT, INK, INK_SOFT, PAPER, css, mix } from '../render/palette.ts';
import { drawSilhouette, silhouette } from '../render/silhouette.ts';
import { traits } from '../render/traits.ts';
import type { Tag } from './words.ts';

/** At this picture size or less a card draws the silhouette, not the bake. */
export const SILHOUETTE_MAX = 48;
export const MATERIALS_BASE = '/assets/materials/';

const WHITE = [255, 255, 255] as const;

const CSS = `
.clade-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; margin: 0;
  width: calc(var(--clade-pic) + 16px); padding: 8px; border-radius: 8px;
  background: ${css(mix(PAPER, WHITE, 0.55))}; color: ${css(INK)}; border: 1px solid ${css(INK, 0.16)};
  font: 13px/1.35 system-ui, -apple-system, sans-serif; }
.clade-card.compact { flex-direction: row; align-items: center; width: auto; min-width: 0; }
.clade-card canvas { display: block; align-self: center; flex: none; }
.clade-card-body { display: grid; gap: 3px; min-width: 0; }
.clade-card-name { margin: 0; font-size: 13px; font-weight: 650; line-height: 1.25; overflow-wrap: anywhere; }
.clade-card-meta { margin: 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
  color: ${css(INK_SOFT)}; font-size: 12px; }
.clade-card-tag { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; letter-spacing: .02em;
  border: 1px solid ${css(INK)}; }
.clade-card-tag[data-tag="founder"] { background: ${css(INK)}; color: ${css(PAPER)}; }
.clade-card-tag[data-tag="young"] { background: transparent; color: ${css(INK)}; }
.clade-card-tag[data-tag="captured"] { background: ${css(ACCENT)}; border-color: ${css(ACCENT)}; color: ${css(INK)}; }
.clade-card-lines { margin: 2px 0 0; padding: 0; list-style: none; display: grid; gap: 4px;
  color: ${css(INK_SOFT)}; font-size: 12px; line-height: 1.35; }
.clade-card-lines strong { color: ${css(INK)}; font-weight: 650; }
`;

function injectStyle(): void {
  if (document.getElementById('clade-card-style')) return;
  const style = document.createElement('style');
  style.id = 'clade-card-style';
  style.textContent = CSS;
  document.head.append(style);
}

/** A cache key for a genome's picture: two 32-bit FNV-1a hashes of its 216 bytes. */
export function genomeKey(g: Genome): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < g.length; i++) {
    a = Math.imul(a ^ g[i], 0x01000193);
    b = Math.imul(b ^ g[i] ^ (i & 255), 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The size class in plain words: tiny, small, medium, big or huge. */
export function sizeClass(g: Genome): string {
  return FORMS[0][express(g).tier];
}

let materials: Promise<void> | null = null;
function ensureMaterials(base: string): Promise<void> {
  if (!materials) materials = loadMaterials(base).catch((e: unknown) => { materials = null; throw e; });
  return materials;
}

export interface PictureOptions {
  /** CSS px square. Default 128. At SILHOUETTE_MAX or less, the silhouette is drawn. */
  size?: number;
  /** Default: the device's ratio, capped at 3. */
  dpr?: number;
  materialsBase?: string;
}

export interface Picture {
  element: HTMLCanvasElement;
  /** Resolves when the picture is drawn; rejects if the bake failed. */
  ready: Promise<void>;
}

export function creaturePicture(g: Genome, opts: PictureOptions = {}): Picture {
  const size = opts.size ?? 128;
  const dpr = opts.dpr ?? Math.min(globalThis.devicePixelRatio || 1, 3);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(size * dpr));
  c.height = c.width;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', label(g));
  const g2 = c.getContext('2d');
  if (!g2) return { element: c, ready: Promise.reject(new Error('2D canvas context unavailable')) };
  const tr = traits(g);
  if (size <= SILHOUETTE_MAX) {
    g2.scale(c.width / size, c.height / size);
    drawSilhouette(g2, silhouette(tr, size), 0, 0);
    c.dataset.drawn = 'silhouette';
    return { element: c, ready: Promise.resolve() };
  }
  const ready = ensureMaterials(opts.materialsBase ?? MATERIALS_BASE)
    .then(() => bake(tr, genomeKey(g), size, dpr))
    .then((b) => {
      g2.clearRect(0, 0, c.width, c.height);
      g2.drawImage(b.bitmap, 0, 0, c.width, c.height);
      c.dataset.drawn = 'bake';
    });
  return { element: c, ready };
}

export interface CardOptions extends PictureOptions {
  /** Where the creature came from. Omitted: no tag. */
  tag?: Tag;
  /** Birth lines (ui/birth.ts). A "system: rest" line gets its system in bold. */
  lines?: readonly string[];
}

export interface Card {
  element: HTMLElement;
  ready: Promise<void>;
}

export function creatureCard(g: Genome, opts: CardOptions = {}): Card {
  injectStyle();
  const size = opts.size ?? 128;
  const pic = creaturePicture(g, opts);
  const root = document.createElement('div');
  root.className = size <= SILHOUETTE_MAX ? 'clade-card compact' : 'clade-card';
  root.style.setProperty('--clade-pic', `${size}px`);
  if (opts.tag) root.dataset.tag = opts.tag;

  const body = document.createElement('div');
  body.className = 'clade-card-body';
  const name = document.createElement('p');
  name.className = 'clade-card-name';
  name.textContent = label(g);
  const meta = document.createElement('p');
  meta.className = 'clade-card-meta';
  const sz = document.createElement('span');
  sz.className = 'clade-card-size';
  sz.textContent = sizeClass(g);
  meta.append(sz);
  if (opts.tag) {
    const t = document.createElement('span');
    t.className = 'clade-card-tag';
    t.dataset.tag = opts.tag;
    t.textContent = opts.tag;
    meta.append(t);
  }
  body.append(name, meta);

  if (opts.lines?.length) {
    const ul = document.createElement('ul');
    ul.className = 'clade-card-lines';
    for (const line of opts.lines) {
      const li = document.createElement('li');
      const cut = line.indexOf(': ');
      if (cut > 0 && cut < 20) {
        const b = document.createElement('strong');
        b.textContent = line.slice(0, cut + 1);
        li.append(b, line.slice(cut + 1));
      } else {
        li.textContent = line;
      }
      ul.append(li);
    }
    body.append(ul);
  }

  root.append(pic.element, body);
  return { element: root, ready: pic.ready };
}
