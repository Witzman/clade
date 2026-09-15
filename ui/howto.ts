// The how-to-play overlay shell and the counters panel. Workshop issue #61.
//
//   const h = openHowto({ title: 'How to play', paragraphs: [...], steps: [...], after: [...] });
//   await h.closed;
//
// One screen, one close button at the bottom, Escape or a tap on the backdrop
// also closes. Each variant supplies its own words; the counters panel is
// appended to every one of them with the shared wording from ui/words.ts, so
// no variant can drift from it. The top-right corner is left to the shared
// sound control (audio/control.ts sits above this overlay).
//
// Browser-only (DOM).

import { INK, INK_SOFT, PAPER, SLATE, css, mix } from '../render/palette.ts';
import { COUNTERS_TEXT, COUNTERS_TITLE } from './words.ts';

const WHITE = [255, 255, 255] as const;

const CSS = `
.clade-howto { position: fixed; inset: 0; z-index: 900; box-sizing: border-box; overflow-y: auto;
  overscroll-behavior: contain; background: ${css(SLATE, 0.78)};
  padding: max(64px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
.clade-howto-panel { box-sizing: border-box; max-width: 36rem; margin: 0 auto; padding: 20px 20px 16px;
  border-radius: 12px; background: ${css(PAPER)}; color: ${css(INK)};
  font: 15px/1.5 system-ui, -apple-system, sans-serif; }
.clade-howto-panel h2 { margin: 0 0 10px; font-size: 20px; line-height: 1.25; }
.clade-howto-panel p { margin: 0 0 10px; }
.clade-howto-panel ol { margin: 0 0 10px; padding-left: 1.4em; }
.clade-howto-panel li { margin: 0 0 4px; }
.clade-counters { margin: 14px 0 0; padding: 10px 12px; border-radius: 8px;
  background: ${css(mix(PAPER, WHITE, 0.55))}; border-left: 4px solid ${css(INK_SOFT)}; }
.clade-counters h3 { margin: 0 0 4px; font-size: 15px; }
.clade-counters p { margin: 0; }
.clade-howto-close { display: block; width: 100%; min-height: 44px; margin: 16px 0 0; border-radius: 8px;
  border: 1px solid ${css(INK)}; background: ${css(INK)}; color: ${css(PAPER)};
  font: 600 16px/1 system-ui, -apple-system, sans-serif; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.clade-howto-close:focus-visible { outline: 3px solid ${css(INK_SOFT)}; outline-offset: 2px; }
`;

function injectStyle(): void {
  if (document.getElementById('clade-howto-style')) return;
  const style = document.createElement('style');
  style.id = 'clade-howto-style';
  style.textContent = CSS;
  document.head.append(style);
}

/** The counters panel: identical wording on every how-to-play screen. */
export function countersPanel(): HTMLElement {
  injectStyle();
  const s = document.createElement('section');
  s.className = 'clade-counters';
  const h = document.createElement('h3');
  h.textContent = COUNTERS_TITLE;
  const p = document.createElement('p');
  p.textContent = COUNTERS_TEXT;
  s.append(h, p);
  return s;
}

export interface HowtoContent {
  title: string;
  /** Paragraphs before the numbered steps. */
  paragraphs?: readonly string[];
  steps?: readonly string[];
  /** Paragraphs after the steps, before the counters panel. */
  after?: readonly string[];
}

export interface Howto {
  element: HTMLElement;
  close(): void;
  /** Resolves once, when the overlay is closed by any route. */
  closed: Promise<void>;
}

let seq = 0;

export function openHowto(content: HowtoContent, opts: { parent?: HTMLElement; closeLabel?: string } = {}): Howto {
  injectStyle();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const id = `clade-howto-title-${++seq}`;

  const root = document.createElement('div');
  root.className = 'clade-howto';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', id);

  const panel = document.createElement('div');
  panel.className = 'clade-howto-panel';
  const h = document.createElement('h2');
  h.id = id;
  h.textContent = content.title;
  panel.append(h);
  const para = (t: string) => { const p = document.createElement('p'); p.textContent = t; return p; };
  for (const t of content.paragraphs ?? []) panel.append(para(t));
  if (content.steps?.length) {
    const ol = document.createElement('ol');
    for (const t of content.steps) { const li = document.createElement('li'); li.textContent = t; ol.append(li); }
    panel.append(ol);
  }
  for (const t of content.after ?? []) panel.append(para(t));
  panel.append(countersPanel());

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clade-howto-close';
  btn.textContent = opts.closeLabel ?? 'Close';
  panel.append(btn);
  root.append(panel);

  let resolve!: () => void;
  const closed = new Promise<void>((r) => { resolve = r; });
  let open = true;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  function close(): void {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey);
    root.remove();
    opener?.focus();
    resolve();
  }
  btn.addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', onKey);

  (opts.parent ?? document.body).append(root);
  btn.focus({ preventScroll: true });
  return { element: root, close, closed };
}
