// Variant B's tier 1 client: one expedition against the computer expedition on
// the same seed, in the browser. Workshop issue #65, build plan 2026-09-15
// piece B2; variant directions §5 with the §2.7 amendments.
//
// Screens: menu, founder choice (three of six), breed (route strip, herd,
// divergence), the young (keep one), release above eight, the lineup (the
// opponent's three shown, bring three that fit the limit), the crossing notice,
// the answer screen as each opponent creature steps up, the fight replay with
// the capture move, and the run end with both herds side by side. The run is
// (seed, decisions) in localStorage and a reload resumes it (web/b/session.ts).
// The rules are web/b/run.ts; nothing here decides an outcome.
//
// The top-right corner belongs to the shared sound control. Colours come from
// render/palette.ts only. Touch first: taps, 44 px targets, no hover rules.
// A2's layout conventions are copied, not imported: variants never import
// each other.

import { sharedAudio } from '../../audio/index.ts';
import { mountAudioControl } from '../../audio/control.ts';
import { divergence, label } from '../../core/index.ts';
import { ACCENT, INK, INK_SOFT, PAPER, css, mix } from '../../render/palette.ts';
import { birthSentences, parentsLine } from '../../ui/birth.ts';
import { creatureCard } from '../../ui/card.ts';
import { fightEvents } from '../../ui/fight-events.ts';
import { herdGrid, type HerdGrid } from '../../ui/grid.ts';
import { openHowto } from '../../ui/howto.ts';
import { mountReplay, type Replay } from '../../ui/replay.ts';
import type { Tag } from '../../ui/words.ts';
import { MIN_HERD, statsOf } from './base.ts';
import {
  CHOOSE, DEAL, HERD_CAP, LINEUP, LITTER, PLAYER, STOPS, apply, eligible, fits, isCrossing, limit, newRun,
  stepping, tierOf, upcoming, type Creature, type Run,
} from './run.ts';
import { LIMIT_WORDS, STORAGE_KEY, decode, encode, fightsOf, replayStepMs, screenOf, type ShownFight } from './session.ts';

const audio = sharedAudio();
mountAudioControl(audio);

const WHITE = [255, 255, 255] as const;
const CARD = css(mix(PAPER, WHITE, 0.55));

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: ${css(PAPER)}; color: ${css(INK)};
  font: 15px/1.45 system-ui, -apple-system, sans-serif; -webkit-text-size-adjust: 100%; }
#app { max-width: 64rem; margin: 0 auto;
  padding: max(64px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 32px max(16px, env(safe-area-inset-left)); }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 4px; }
h2 { font-size: 20px; line-height: 1.25; margin: 0 0 6px; }
h3 { font-size: 15px; margin: 0 0 8px; }
p { margin: 0 0 10px; }
.b-soft { color: ${css(INK_SOFT)}; }
.b-btn { font: 600 16px/1.2 system-ui, -apple-system, sans-serif; min-height: 44px; min-width: 44px; padding: 10px 18px;
  border-radius: 8px; border: 1px solid ${css(INK)}; background: ${CARD}; color: ${css(INK)}; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.b-btn.primary { background: ${css(INK)}; color: ${css(PAPER)}; }
.b-btn:disabled { opacity: .4; cursor: default; }
.b-btn:focus-visible { outline: 3px solid ${css(ACCENT)}; outline-offset: 2px; }
.b-menu { display: grid; gap: 10px; max-width: 24rem; margin-top: 20px; }
.b-menu .b-btn { width: 100%; }
.b-bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 0 0 12px; }
.b-bar .b-count { font-weight: 650; font-variant-numeric: tabular-nums; }
.b-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 14px 0; }
.b-note { padding: 10px 12px; border-radius: 8px; background: ${CARD}; border-left: 4px solid ${css(ACCENT)}; margin: 0 0 14px; }
.b-cols { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-start; }
.b-cols > section { flex: 1 1 300px; min-width: 0; }
.b-herd .clade-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
.b-herd .clade-cell { justify-content: stretch; }
.b-litter .clade-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.b-deal .clade-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.b-trio .clade-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
.b-pair { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; min-height: 60px; margin: 6px 0 0; }
.b-pair:empty { display: none; }
.b-sticky { position: sticky; top: 0; z-index: 5; margin: 8px 0; padding: 8px 0; background: ${css(PAPER)}; }
.b-section-title { margin-top: 24px; }
.b-div { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
.b-panel { padding: 12px; border-radius: 10px; background: ${css(INK, 0.04)}; border: 1px solid ${css(INK, 0.1)}; margin: 0 0 16px; }
.b-outcome { font-size: 18px; font-weight: 650; margin: 8px 0 6px; }
.b-move { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.b-move .clade-card { animation: b-move 900ms ease-in-out both; }
.b-move[data-dir="left"] .clade-card { --b-from: 60px; }
.b-move[data-dir="right"] .clade-card { --b-from: -60px; }
@keyframes b-move { from { transform: translateX(var(--b-from, 0)); opacity: .2; } to { transform: none; opacity: 1; } }
.b-reveal .clade-cell { animation: b-in 320ms ease-out both; }
.b-reveal .clade-cell:nth-child(2) { animation-delay: 120ms; }
.b-reveal .clade-cell:nth-child(3) { animation-delay: 240ms; }
@keyframes b-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.b-fighters { display: flex; flex-wrap: wrap; gap: 8px 12px; max-width: 640px; margin: 0 0 12px; }
.b-fighters > div { flex: 1 1 250px; min-width: 0; }
.b-fighters .clade-card { width: 100%; }
.b-stepping { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; margin: 0 0 12px; }

/* The route strip: nine stops, the next three limits readable, the rest not yet. */
.b-route { display: flex; gap: 4px; margin: 0 0 14px; overflow: hidden; }
.b-route-h { margin: 0 0 6px; color: ${css(INK_SOFT)}; font-weight: 600; }
.b-stop { flex: 1 1 0; min-width: 0; padding: 6px 4px; border-radius: 6px; text-align: center;
  background: ${css(INK, 0.05)}; border: 1px solid ${css(INK, 0.12)}; }
.b-stop[data-past="1"] { opacity: .45; }
.b-stop[data-now="1"] { border-color: ${css(INK)}; background: ${CARD}; box-shadow: inset 0 -3px 0 ${css(ACCENT)}; }
.b-stop[data-crossing="1"] .b-stop-n { color: ${css(ACCENT)}; }
.b-stop-n { display: block; font-weight: 650; font-variant-numeric: tabular-nums; font-size: 13px; }
.b-stop-lim { display: block; font-size: 11px; line-height: 1.25; color: ${css(INK_SOFT)}; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .b-reveal .clade-cell, .b-move .clade-card { animation: none; } }
`;
{
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------- storage
// localStorage can throw (private mode, disabled storage). A run that cannot be
// saved still plays; it just does not survive a reload.
function load(): { run: Run; seen: number } | null {
  try { return decode(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function save(): void {
  if (!run) return;
  try { localStorage.setItem(STORAGE_KEY, encode(run, seen)); } catch { /* not saved */ }
}
function clear(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}

// ---------------------------------------------------------------- state
let run: Run | null = null;
let seen = 0;                 // fights whose replay has been played to the end
let crossingAck = 0;          // the stop whose crossing notice has been read
let screen: string = 'menu';
let replay: Replay | null = null;
let epoch = 0;                // bumps on every screen change, so a finished replay from a screen left behind is dropped

const app = document.getElementById('app')!;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...kids);
  return e;
}
function button(text: string, onClick: () => void, opts: { primary?: boolean; id?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: opts.primary ? 'b-btn primary' : 'b-btn', text });
  b.type = 'button';
  if (opts.id) b.id = opts.id;
  b.addEventListener('click', onClick);
  return b;
}
function show(name: string, ...kids: Node[]): void {
  epoch++;
  replay?.destroy();
  replay = null;
  screen = name;
  document.body.dataset.screen = name;
  app.replaceChildren(...kids);
  window.scrollTo(0, 0);
}

const tagOf = (c: Creature): Tag | undefined => (c.origin === 'rival' ? undefined : c.origin);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- shared furniture
function bar(r: Run): HTMLElement {
  const stop = Math.min(Math.max(r.stop, 1), STOPS);
  return h('div', { class: 'b-bar' },
    button('Menu', menu, { id: 'menu' }),
    h('span', { text: r.phase === 'over' ? 'The route is behind you' : `Stop ${stop} of ${STOPS}` }),
    h('span', { class: 'b-count', text: `Your herd ${r.exps[PLAYER].herd.length}` }),
    h('span', { class: 'b-soft', text: isCrossing(stop) ? 'a crossing' : `this stop takes ${LIMIT_WORDS[limit(r)]}` }),
  );
}

/** Nine stops; this one and the next two show their limit, the rest are not known yet. */
function routeStrip(r: Run): HTMLElement {
  const at = Math.min(Math.max(r.stop, 1), STOPS);
  const ahead = upcoming(r);
  const strip = h('div', { class: 'b-route' });
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'The route');
  for (let k = 1; k <= STOPS; k++) {
    const known = k >= at && k - at < ahead.length;
    const cell = h('div', { class: 'b-stop' },
      h('span', { class: 'b-stop-n', text: isCrossing(k) ? `${k} ✦` : String(k) }),
      h('span', { class: 'b-stop-lim', text: known ? LIMIT_WORDS[ahead[k - at]] : '·' }));
    cell.dataset.stop = String(k);
    if (isCrossing(k)) cell.dataset.crossing = '1';
    if (k < at) cell.dataset.past = '1';
    if (k === at && r.phase !== 'over') cell.dataset.now = '1';
    cell.title = isCrossing(k) ? `Stop ${k}: a crossing` : `Stop ${k}`;
    strip.append(cell);
  }
  return h('div', {}, h('h3', { class: 'b-route-h', text: `The route — ${plural(STOPS, 'stop')}, crossings marked ✦` }), strip);
}

function myHerdGrid(r: Run, max: number, onChange?: (p: readonly number[]) => void): HerdGrid {
  const herd = r.exps[PLAYER].herd;
  return herdGrid(herd.map(c => c.g), {
    max, size: 48, tags: herd.map(tagOf), onChange, label: 'Your herd',
  });
}
function herdSection(title: string, herd: readonly Creature[], grid?: HerdGrid, side = 'mine'): HTMLElement {
  const g = grid ?? herdGrid(herd.map(c => c.g), { max: 0, size: 48, tags: herd.map(tagOf), label: title });
  const s = h('section', { class: 'b-herd' }, h('h3', { text: `${title} (${herd.length})` }), g.element);
  s.dataset.side = side;
  return s;
}
function trio(title: string, cs: readonly Creature[], cls: string, side: string): HTMLElement {
  const g = herdGrid(cs.map(c => c.g), { max: 0, size: 96, tags: cs.map(tagOf), label: title });
  const s = h('section', { class: `b-trio ${cls}` }, h('h3', { text: title }), g.element);
  s.dataset.side = side;
  return s;
}

// ---------------------------------------------------------------- menu
function menu(): void {
  const saved = run && run.phase !== 'over' ? run : null;
  const items: Node[] = [];
  if (saved) items.push(button(`Continue the expedition (stop ${Math.min(saved.stop, STOPS)})`, render, { primary: true, id: 'continue' }));
  items.push(button(saved ? 'Start a new expedition' : 'Start an expedition', newExpedition, { primary: !saved, id: 'play' }));
  items.push(button('How to play', howto, { id: 'howto' }));
  items.push(button('What is faked', faked, { id: 'faked' }));
  show('menu',
    h('h1', { text: 'B' }),
    h('p', { class: 'b-soft', text: `A route of ${STOPS} stops, against another expedition on the same route. One run, and what is lost stays lost.` }),
    h('div', { class: 'b-menu' }, ...items),
  );
}

function newExpedition(): void {
  const q = Number(new URLSearchParams(location.search).get('seed'));
  const seedValue = Number.isInteger(q) && q > 0 && q <= 0xffffffff ? q : crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  run = newRun(seedValue);
  seen = 0;
  crossingAck = 0;
  save();
  render();
}

// ---- how to play: the amended rules (§5.4 as amended by §2.7), not §5.9's draft
function howto(): void {
  openHowto({
    title: 'How to play',
    paragraphs: [
      `Your expedition follows a route of ${STOPS} stops. Everyone on the same route meets the same rivals, and so does the other expedition you are measured against.`,
      `Choose ${CHOOSE} of ${DEAL} creatures to begin. The limits of this stop and the next two are always shown. At each stop:`,
    ],
    steps: [
      `Choose two of your creatures to breed. ${LITTER} young are born. Keep one; the other two are released. Your herd holds ${HERD_CAP}, and above that you release down to ${HERD_CAP} yourself.`,
      `A rival herd of ${LINEUP} waits. Bring ${LINEUP} of your creatures that meet the stop's size limit. If you cannot field ${LINEUP} that fit, each empty place is a lost fight, and nothing changes sides for it.`,
      'The rivals come one at a time, and you answer each with one of the three you brought. You see the creature in front of you before you choose your answer, and each of yours fights once.',
      'Every creature that loses joins the other side. A rival herd is left behind at its stop, so one of yours lost there is gone for good.',
    ],
    after: [
      `If your herd falls below ${MIN_HERD} creatures, the expedition ends.`,
      'Stops 3, 6 and 9 are crossings. There you meet the other expedition on your route instead of a rival herd, and creatures change sides between the two runs.',
      'The expedition that goes further wins. If both finish, the larger herd wins; if the herds are level, the one that won more crossing fights.',
      "Nothing is rerolled: reloading the page returns exactly the same expedition. Young inherit one of each parent's two copies of every body part, and when the parents' parts are very different a young animal may grow a part that neither parent had.",
    ],
  });
}

function faked(): void {
  const o = openHowto({
    title: 'What is faked',
    paragraphs: ['This is a playable slice. Some of it stands in for the real thing:'],
    steps: [
      `The ${DEAL} creatures you choose from are random, not the real animals they will be.`,
      'The run seed is chosen by this browser, and the whole expedition runs in this browser.',
      'The other expedition is always the computer. Meeting a person at a crossing is not built yet.',
      'No sounds are tied to the game yet. The sound control works.',
    ],
    after: ['Your expedition is kept in this browser, so a reload continues it.'],
  });
  o.element.querySelector('.clade-counters')?.remove();
}

// ---------------------------------------------------------------- the router
function render(): void {
  if (!run) return menu();
  const r = run;
  switch (screenOf(r, seen)) {
    case 'fight': return fightScreen(r);
    case 'founders': return foundersScreen(r);
    case 'breed': return breedScreen(r);
    case 'keep': return keepScreen(r);
    case 'release': return releaseScreen(r);
    case 'lineup': return isCrossing(r.stop) && crossingAck !== r.stop ? crossingScreen(r) : lineupScreen(r);
    case 'answer': return answerScreen(r);
    case 'over': return endScreen(r);
  }
}

function step(d: Parameters<typeof apply>[1]): void {
  apply(run!, d);
  save();
  render();
}

// ---------------------------------------------------------------- founders
function foundersScreen(r: Run): void {
  const go = button(`Take these ${CHOOSE}`, () => {
    const p = grid.picked();
    if (p.length !== CHOOSE) return;
    go.disabled = true;
    step({ t: 'founders', pick: p.slice() });
  }, { primary: true, id: 'take-founders' });
  go.disabled = true;
  const hint = h('p', { class: 'b-soft' });
  const grid = herdGrid(r.deal.map(g => g), {
    max: CHOOSE, size: 128, tags: r.deal.map(() => 'founder' as const), label: 'The creatures on offer',
    onChange: (p) => {
      go.disabled = p.length !== CHOOSE;
      hint.textContent = p.length === CHOOSE ? 'Ready.' : `Tap ${plural(CHOOSE - p.length, 'more creature')}.`;
    },
  });
  hint.textContent = `Tap ${plural(CHOOSE, 'creature')}.`;
  show('founders',
    h('div', { class: 'b-bar' }, button('Menu', menu, { id: 'menu' })),
    h('h1', { text: 'Choose your expedition' }),
    h('p', { text: `Three of these ${DEAL} come with you. The rest stay behind. Watch the limits on the road ahead — you will need the sizes they ask for.` }),
    routeStrip(r),
    h('div', { class: 'b-actions b-sticky' }, go, hint),
    h('section', { class: 'b-deal b-reveal' }, grid.element),
  );
}

// ---------------------------------------------------------------- breed
function breedScreen(r: Run): void {
  const me = r.exps[PLAYER];
  const pairBox = h('div', { class: 'b-pair' });
  const divLine = h('p', { class: 'b-div' });
  const go = button('Breed these two', () => {
    const p = grid.picked();
    if (p.length !== 2) return;
    go.disabled = true;
    step({ t: 'breed', ids: [me.herd[p[0]].id, me.herd[p[1]].id] });
  }, { primary: true, id: 'breed' });
  go.disabled = true;

  const onChange = (p: readonly number[]) => {
    go.disabled = p.length !== 2;
    pairBox.replaceChildren();
    for (const i of p) pairBox.append(creatureCard(me.herd[i].g, { size: 128, tag: tagOf(me.herd[i]) }).element);
    if (p.length < 2) {
      divLine.textContent = p.length === 0 ? 'Tap two of your creatures.' : 'Tap one more.';
      divLine.dataset.value = '';
      return;
    }
    const d = divergence(me.herd[p[0]].g, me.herd[p[1]].g);
    divLine.textContent = `Divergence of this pair: ${Math.round(d)}`;
    divLine.dataset.value = String(Math.round(d));
  };
  const grid = myHerdGrid(r, 2, onChange);
  onChange([]);

  show('breed',
    bar(r),
    routeStrip(r),
    h('h2', { text: `Stop ${r.stop}: choose two parents` }),
    h('p', { class: 'b-soft', text: `${LITTER} young are born, and you keep one of them. Both parents stay in the herd.` }),
    h('div', { class: 'b-panel' }, divLine, pairBox, h('div', { class: 'b-actions' }, go)),
    herdSection('Your herd', me.herd, grid),
  );
}

// ---------------------------------------------------------------- keep one
function keepScreen(r: Run): void {
  const me = r.exps[PLAYER];
  const litter = r.litter!;
  const [ai, bi] = me.pairs[me.pairs.length - 1];
  const find = (id: number) => me.herd.find(c => c.id === id)!;
  const parents = parentsLine(find(ai).g, find(bi).g);
  const go = button('Keep this one', () => {
    const p = grid.picked();
    if (p.length !== 1) return;
    go.disabled = true;
    step({ t: 'keep', i: p[0] });
  }, { primary: true, id: 'keep' });
  go.disabled = true;
  const grid = herdGrid(litter.map(y => y.g), {
    max: 1, size: 128, tags: litter.map(() => 'young' as const),
    lines: litter.map(y => [parents, ...birthSentences(y.fusions)]),
    label: 'The young', onChange: (p) => { go.disabled = p.length !== 1; },
  });
  show('keep',
    bar(r),
    h('h2', { text: `Stop ${r.stop}: the young` }),
    h('p', { class: 'b-soft', text: `${LITTER} were born. Keep one — the other two are released.` }),
    h('div', { class: 'b-actions b-sticky' }, go),
    h('section', { class: 'b-litter b-reveal' }, grid.element),
    h('h3', { class: 'b-section-title', text: 'Your herd' }),
    herdSection('Your herd', me.herd),
  );
}

// ---------------------------------------------------------------- release above eight
function releaseScreen(r: Run): void {
  const me = r.exps[PLAYER];
  const n = me.herd.length - HERD_CAP;
  const go = button(`Release ${plural(n, 'creature')}`, () => {
    const p = grid.picked();
    if (p.length !== n) return;
    go.disabled = true;
    step({ t: 'release', ids: p.map(i => me.herd[i].id) });
  }, { primary: true, id: 'release' });
  go.disabled = true;
  const hint = h('p', { class: 'b-soft', text: `Tap ${plural(n, 'creature')} to release.` });
  const grid = myHerdGrid(r, n, (p) => {
    go.disabled = p.length !== n;
    hint.textContent = p.length === n ? 'Ready.' : `Tap ${plural(n - p.length, 'more')}.`;
  });
  show('release',
    bar(r),
    routeStrip(r),
    h('h2', { text: 'Your herd is over the limit' }),
    h('p', { class: 'b-note', text: `A herd holds ${HERD_CAP}. You have ${me.herd.length}. Release ${plural(n, 'creature')} before you go on — a released creature does not come back.` }),
    h('div', { class: 'b-actions b-sticky' }, go, hint),
    herdSection('Your herd', me.herd, grid),
  );
}

// ---------------------------------------------------------------- the crossing notice
function crossingScreen(r: Run): void {
  const me = r.exps[PLAYER];
  show('crossing',
    bar(r),
    routeStrip(r),
    h('h1', { text: `Stop ${r.stop}: a crossing` }),
    h('p', { text: 'No rival herd here. The other expedition set out from the same six creatures you did, on this same route, and this is where the two of you meet.' }),
    h('p', { class: 'b-note', text: 'Creatures change sides between the two runs: what you win here, they lose, and what you lose here goes on with them.' }),
    h('div', { class: 'b-actions' }, button('Go to meet them', () => { crossingAck = r.stop; render(); }, { primary: true, id: 'to-lineup' })),
    h('div', { class: 'b-cols' },
      herdSection('Your herd', me.herd, undefined, 'mine'),
      herdSection('The other expedition', r.exps[1].herd, undefined, 'theirs')),
  );
}

// ---------------------------------------------------------------- the lineup
function lineupScreen(r: Run): void {
  const me = r.exps[PLAYER];
  const crossing = isCrossing(r.stop);
  const lim = limit(r);
  const fitIx = me.herd.map((c, i) => (fits(lim, tierOf(c.g)) ? i : -1)).filter(i => i >= 0);
  const want = Math.min(LINEUP, fitIx.length);
  const theirs = r.opponent!;

  const go = button(want === 1 ? 'Bring this one' : `Bring ${plural(want, 'creature')}`, () => {
    const p = grid.picked();
    if (p.length !== want) return;
    go.disabled = true;
    step({ t: 'lineup', ids: p.map(i => me.herd[i].id) });
  }, { primary: true, id: 'bring' });
  go.disabled = true;
  const hint = h('p', { class: 'b-soft' });
  const grid = myHerdGrid(r, want, (p) => {
    go.disabled = p.length !== want;
    hint.textContent = p.length === want ? 'Ready.' : `Tap ${plural(want - p.length, 'more')}.`;
  });
  grid.setDisabled(me.herd.map((_, i) => i).filter(i => !fitIx.includes(i)));
  hint.textContent = `Tap ${plural(want, 'creature')}.`;

  const kids: Node[] = [bar(r), routeStrip(r),
    h('h2', { text: crossing ? `Stop ${r.stop}: the other expedition brings ${plural(theirs.length, 'creature')}` : `Stop ${r.stop}: the rival herd` }),
    h('p', { class: 'b-soft', text: `This stop takes ${LIMIT_WORDS[lim]}. They come one at a time and you answer each with one of the three you bring, so the order is theirs and the answer is yours.` })];
  if (fitIx.length < LINEUP) {
    kids.push(h('p', { class: 'b-note', text: `Only ${plural(fitIx.length, 'creature')} in your herd ${fitIx.length === 1 ? 'meets' : 'meet'} this limit. Each place you cannot fill is a lost fight — but nothing of yours changes sides for it.` }));
  }
  kids.push(
    trio(crossing ? 'Their three' : 'The rival herd', theirs, 'b-reveal', 'theirs'),
    h('div', { class: 'b-actions b-sticky' }, go, hint),
    herdSection('Your herd', me.herd, grid),
  );
  show('lineup', ...kids);
}

// ---------------------------------------------------------------- answer each
function answerScreen(r: Run): void {
  const crossing = isCrossing(r.stop);
  const up = stepping(r)!;
  const brought = r.brought!;
  const open = brought.map((c, slot) => ({ c, slot })).filter(({ slot }) => r.mineLeft & (1 << slot));
  const theirs = r.opponent!;
  // Who is left on their side, not counting the one in front of you. Their
  // order is theirs to know; which of them are still to come is not a secret.
  const waiting = theirs.filter((_, i) => (r.theirsLeft & (1 << i)) && i !== r.order![r.step]);

  const go = button('Send this one', () => {
    const p = grid.picked();
    if (p.length !== 1) return;
    go.disabled = true;
    step({ t: 'answer', slot: open[p[0]].slot });
  }, { primary: true, id: 'send' });
  go.disabled = true;
  const grid = herdGrid(open.map(o => o.c.g), {
    max: 1, size: 96, tags: open.map(o => tagOf(o.c)), label: 'The creatures you brought',
    onChange: (p) => { go.disabled = p.length !== 1; },
  });

  const mine = h('section', { class: 'b-trio' }, h('h3', { text: `Yours, still to answer with (${open.length})` }), grid.element);
  mine.dataset.side = 'mine';
  const kids: Node[] = [
    bar(r),
    h('h2', { text: `Stop ${r.stop}: fight ${r.step + 1} of ${Math.min(brought.length, theirs.length)}` }),
    h('p', { text: `${crossing ? 'The other expedition sends this one forward.' : 'This one steps out of the rival herd.'} Answer with one of the ${open.length === 1 ? 'one you have left' : `${open.length} you have left`}.` }),
    h('div', { class: 'b-stepping' },
      h('div', {}, h('h3', { text: crossing ? 'Theirs, stepping up' : 'Stepping up' }), creatureCard(up.g, { size: 128, tag: tagOf(up) }).element)),
  ];
  if (r.step > 0) kids.push(h('p', { class: 'b-soft', text: `Here so far: ${r.wins} of ${r.step} won.` }));
  kids.push(h('div', { class: 'b-actions b-sticky' }, go), mine);
  if (waiting.length) {
    const rest = herdSection(crossing ? 'Theirs, still to come' : 'The rival herd, still to come', waiting, undefined, 'theirs');
    rest.classList.add('b-section-title');
    kids.push(rest);
  }
  show('answer', ...kids);
}

// ---------------------------------------------------------------- the fight, and the capture
function fightScreen(r: Run): void {
  const f: ShownFight = fightsOf(r)[seen];
  const rec = fightEvents(statsOf(f.mine.g), statsOf(f.theirs.g));
  const expected = rec.result > 0 ? 1 : rec.result < 0 ? -1 : 0;
  if (expected !== f.rec.result) console.error(`replay disagrees with the rules at stop ${f.stop}`);
  const actions = rec.events.filter(e => e.kind === 'strike').length;
  const stage = h('div');
  const after = h('div');
  const mineName = `your ${label(f.mine.g)}`;
  const theirsName = `${f.crossing ? 'their' : 'the rival'} ${label(f.theirs.g)}`;

  show('fight',
    bar(r),
    h('h2', { text: `Stop ${f.stop}: the fight` }),
    h('div', { class: 'b-fighters' },
      h('div', {}, h('h3', { text: 'Yours' }), creatureCard(f.mine.g, { size: 48, tag: tagOf(f.mine) }).element),
      h('div', {}, h('h3', { text: f.crossing ? 'Theirs' : 'The rival' }), creatureCard(f.theirs.g, { size: 48, tag: tagOf(f.theirs) }).element)),
    stage, after,
  );
  const rp = mountReplay(stage, rec, { names: { A: mineName, B: theirsName }, stepMs: replayStepMs(actions) });
  replay = rp;
  const mine = epoch;
  rp.finished.then(() => {
    if (mine !== epoch) return;
    document.body.dataset.fightDone = String(seen);
    const won = f.rec.result;
    const kids: Node[] = [h('p', { class: 'b-outcome', text: won > 0 ? 'You win the fight.' : won < 0 ? 'You lose the fight.' : 'A drawn fight. Nobody changes sides.' })];
    if (won !== 0) {
      const loser = won > 0 ? f.theirs : f.mine;
      const line = won > 0
        ? `${f.crossing ? "The other expedition's" : "The rival herd's"} ${label(loser.g)} lost, and joins your herd.`
        : f.crossing
          ? `Your ${label(loser.g)} lost, and goes on with the other expedition.`
          : `Your ${label(loser.g)} lost, and stays with the rival herd. The rival herd is left behind at this stop, so it is gone.`;
      const move = h('div', { class: 'b-move' }, creatureCard(loser.g, { size: 48, tag: 'captured' }).element, h('span', { text: line }));
      move.dataset.dir = won > 0 ? 'left' : 'right';
      move.id = 'capture';
      kids.push(move);
    }
    kids.push(h('div', { class: 'b-actions' }, button('Continue', () => {
      seen++;
      save();
      render();
    }, { primary: true, id: 'continue-fight' })));
    after.replaceChildren(...kids);
  });
}

// ---------------------------------------------------------------- the end
const reached = (end: number) => (end > STOPS ? `went the whole route of ${STOPS} stops` : `ended at stop ${end}`);

function endScreen(r: Run): void {
  const res = r.result!;
  const [me, them] = r.exps;
  const title = res.winner === null ? 'A draw' : res.winner === PLAYER ? 'Your expedition wins' : 'The other expedition wins';
  const why = res.by === 'further'
    ? `You ${reached(res.ends[0])}. The other expedition ${reached(res.ends[1])}.`
    : res.by === 'herd'
      ? `Both ${reached(res.ends[0])}. The larger herd wins: yours ${res.herds[0]}, theirs ${res.herds[1]}.`
      : res.by === 'crossings'
        ? `Both ${reached(res.ends[0])}, and both herds hold ${res.herds[0]}. Crossing fights won: you ${res.crossingWins[0]}, them ${res.crossingWins[1]}.`
        : `Both ${reached(res.ends[0])}, both herds hold ${res.herds[0]}, and the crossings were level at ${res.crossingWins[0]} each.`;
  const fights = fightsOf(r);
  const wonCount = fights.filter(f => f.rec.result > 0).length;

  show('over',
    h('div', { class: 'b-bar' }, button('Menu', menu, { id: 'menu' })),
    h('h1', { text: title }),
    h('p', { text: why }),
    h('p', { class: 'b-soft', text: `${plural(me.stops.length, 'stop')} answered, ${wonCount} of ${plural(fights.length, 'fight')} won, ${plural(me.crossingWins, 'crossing fight')} won. Run ${r.seed}.` }),
    routeStrip(r),
    h('div', { class: 'b-actions' }, button('New expedition', newExpedition, { primary: true, id: 'new-run' }), button('Menu', menu)),
    h('div', { class: 'b-cols' },
      herdSection('Your herd at the end', me.herd, undefined, 'mine'),
      herdSection('Theirs', them.herd, undefined, 'theirs')),
  );
}

// ---------------------------------------------------------------- start
const stored = load();
if (stored) { run = stored.run; seen = stored.seen; }
else clear();
if (run) render();
else menu();

// For browser checks: read state, and wrap play() to see which cues fire.
(globalThis as unknown as { clade: object }).clade = {
  audio,
  b: {
    get state() {
      if (!run) return { screen };
      const [me, them] = run.exps;
      return {
        screen, seed: run.seed, stop: run.stop, phase: run.phase, seen,
        herds: [me.herd.length, them.herd.length],
        alive: [me.alive, them.alive],
        eligible: run.phase === 'lineup' ? eligible(run).length : null,
        fights: fightsOf(run).length,
        stops: me.stops.length,
        result: run.result,
      };
    },
  },
};
