// A herd as a grid of cards you tap to pick. Workshop issue #61.
//
//   const grid = herdGrid(genomes, { max: 2, tags, onChange: (picked) => ... });
//   parent.append(grid.element); await grid.ready;
//
// Touch first: a tap toggles a card, every target is at least 44 px, and
// nothing depends on hover (there are no :hover rules at all). `max` is how
// many may be picked at once: 2 to breed, 1 to field, 3 for a lineup. Tapping
// one more than `max` drops the OLDEST pick, so a player never has to untap
// before changing their mind. The order of picks is kept and shown.
//
// Browser-only (DOM). It holds no rules: what a pick means is the caller's.

import type { Genome } from '../core/index.ts';
import { ACCENT, INK, css } from '../render/palette.ts';
import { creatureCard, type CardOptions } from './card.ts';
import type { Tag } from './words.ts';

const CSS = `
.clade-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(calc(var(--clade-pic) + 24px), 1fr)); }
.clade-cell { position: relative; box-sizing: border-box; min-width: 44px; min-height: 44px; padding: 2px;
  display: flex; justify-content: center; border-radius: 10px; border: 2px solid transparent; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; }
.clade-cell .clade-card { width: 100%; }
.clade-cell[aria-pressed="true"] { border-color: ${css(ACCENT)}; box-shadow: 0 0 0 2px ${css(ACCENT)}; }
.clade-cell[aria-disabled="true"] { opacity: .45; cursor: default; }
.clade-cell:focus-visible { outline: 3px solid ${css(INK)}; outline-offset: 2px; }
.clade-pick { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 50%;
  display: none; place-items: center; background: ${css(ACCENT)}; color: ${css(INK)};
  font: 700 13px/1 system-ui, -apple-system, sans-serif; pointer-events: none; }
.clade-cell[aria-pressed="true"] .clade-pick { display: grid; }
`;

function injectStyle(): void {
  if (document.getElementById('clade-grid-style')) return;
  const style = document.createElement('style');
  style.id = 'clade-grid-style';
  style.textContent = CSS;
  document.head.append(style);
}

export interface GridOptions extends Omit<CardOptions, 'tag' | 'lines'> {
  /** How many may be picked at once. Default 2. 0 makes the grid display-only. */
  max?: number;
  /** One tag per creature, or undefined for none. */
  tags?: readonly (Tag | undefined)[];
  /** Birth lines per creature, if the grid shows a litter. */
  lines?: readonly (readonly string[] | undefined)[];
  /** Called with the picked indices, oldest pick first, after every change. */
  onChange?: (picked: readonly number[]) => void;
  /** Accessible name of the group, e.g. "Your herd". */
  label?: string;
}

export interface HerdGrid {
  element: HTMLElement;
  /** Resolves when every picture is drawn. */
  ready: Promise<void>;
  /** Picked indices, oldest pick first. */
  picked(): number[];
  /** Replace the picks (clamped to `max`, last ones kept). Does not call onChange. */
  setPicked(ix: readonly number[]): void;
  /** Cells that cannot be picked; a picked cell that becomes disabled is unpicked. */
  setDisabled(ix: readonly number[]): void;
}

export function herdGrid(genomes: readonly Genome[], opts: GridOptions = {}): HerdGrid {
  injectStyle();
  const max = opts.max ?? 2;
  const size = opts.size ?? 96;
  const root = document.createElement('div');
  root.className = 'clade-grid';
  root.setAttribute('role', 'group');
  if (opts.label) root.setAttribute('aria-label', opts.label);
  root.style.setProperty('--clade-pic', `${size}px`);

  let picks: number[] = [];
  let disabled = new Set<number>();
  const cells: HTMLElement[] = [];
  const readies: Promise<void>[] = [];

  const paint = () => {
    cells.forEach((cell, i) => {
      const k = picks.indexOf(i);
      cell.setAttribute('aria-pressed', String(k >= 0));
      cell.setAttribute('aria-disabled', String(disabled.has(i)));
      (cell.querySelector('.clade-pick') as HTMLElement).textContent = k >= 0 ? String(k + 1) : '';
    });
    root.dataset.picked = picks.join(',');
  };

  const toggle = (i: number) => {
    if (max <= 0 || disabled.has(i)) return;
    const k = picks.indexOf(i);
    if (k >= 0) picks.splice(k, 1);
    else {
      picks.push(i);
      while (picks.length > max) picks.shift();
    }
    paint();
    opts.onChange?.(picks.slice());
  };

  genomes.forEach((g, i) => {
    const card = creatureCard(g, { ...opts, size, tag: opts.tags?.[i], lines: opts.lines?.[i] });
    readies.push(card.ready);
    const cell = document.createElement('div');
    cell.className = 'clade-cell';
    cell.dataset.index = String(i);
    if (max > 0) {
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;
    }
    const badge = document.createElement('span');
    badge.className = 'clade-pick';
    badge.setAttribute('aria-hidden', 'true');
    cell.append(card.element, badge);
    cell.addEventListener('click', () => toggle(i));
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(i); }
    });
    cells.push(cell);
    root.append(cell);
  });
  paint();

  return {
    element: root,
    ready: Promise.all(readies).then(() => undefined),
    picked: () => picks.slice(),
    setPicked(ix) {
      picks = ix.filter((i) => i >= 0 && i < cells.length && !disabled.has(i)).filter((i, k, a) => a.indexOf(i) === k);
      if (picks.length > max) picks = picks.slice(picks.length - Math.max(max, 0));
      paint();
    },
    setDisabled(ix) {
      disabled = new Set(ix);
      picks = picks.filter((i) => !disabled.has(i));
      paint();
    },
  };
}
