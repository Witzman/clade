// Variant A's tier 1 client: one match against the computer, in the browser.
// Workshop issue #62, build plan 2026-09-15 piece A2; variant directions §3.
//
// Screens: menu, breed (both herds, tap two, divergence), the young (both
// litters with birth sentences, tap one to field), the fight replay with the
// capture move, and the match end. A herd-limit release is announced on the
// next breed screen. The match is (seed, decisions) in localStorage and a
// reload resumes it (web/a/session.ts). The rules are server/a/rules.ts, the
// computer server/a/computer.ts; nothing here decides an outcome.
//
// The top-right corner belongs to the shared sound control. Colours come from
// render/palette.ts only. Touch first: taps, 44 px targets, no hover rules.

import { sharedAudio } from '../../audio/index.ts';
import { mountAudioControl } from '../../audio/control.ts';
import { divergence, express, label, stats } from '../../core/index.ts';
import { ACCENT, INK, INK_SOFT, PAPER, css, mix } from '../../render/palette.ts';
import { HERD_LIMIT, ROUNDS, TO_WIN, newMatch, type Creature, type Match, type Side } from '../../server/a/rules.ts';
import { birthSentences, parentsLine } from '../../ui/birth.ts';
import { creatureCard } from '../../ui/card.ts';
import { fightEvents } from '../../ui/fight-events.ts';
import { herdGrid, type HerdGrid } from '../../ui/grid.ts';
import { openHowto } from '../../ui/howto.ts';
import { mountReplay, type Replay } from '../../ui/replay.ts';
import type { Tag } from '../../ui/words.ts';
import {
  CPU, HUMAN, STORAGE_KEY, breedRound, decode, encode, fieldRound, replayStepMs, screenOf, thinkMs, type Screen,
} from './session.ts';

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
.a-soft { color: ${css(INK_SOFT)}; }
.a-btn { font: 600 16px/1.2 system-ui, -apple-system, sans-serif; min-height: 44px; min-width: 44px; padding: 10px 18px;
  border-radius: 8px; border: 1px solid ${css(INK)}; background: ${CARD}; color: ${css(INK)}; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.a-btn.primary { background: ${css(INK)}; color: ${css(PAPER)}; }
.a-btn:disabled { opacity: .4; cursor: default; }
.a-btn:focus-visible { outline: 3px solid ${css(ACCENT)}; outline-offset: 2px; }
.a-menu { display: grid; gap: 10px; max-width: 24rem; margin-top: 20px; }
.a-menu .a-btn { width: 100%; }
.a-bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 0 0 14px; }
.a-bar .a-score { font-weight: 650; font-variant-numeric: tabular-nums; }
.a-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 14px 0; }
.a-note { padding: 10px 12px; border-radius: 8px; background: ${CARD}; border-left: 4px solid ${css(ACCENT)}; margin: 0 0 14px; }
.a-think { min-height: 1.45em; color: ${css(INK_SOFT)}; margin: 0; }
.a-cols { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-start; }
.a-cols > section { flex: 1 1 300px; min-width: 0; }
.a-herd .clade-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
.a-herd .clade-cell { justify-content: stretch; }
.a-litter .clade-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.a-pair { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; min-height: 60px; margin: 6px 0 0; }
.a-pair:empty { display: none; }
.a-sticky { position: sticky; top: 0; z-index: 5; margin: 8px 0; padding: 8px 0; background: ${css(PAPER)}; }
.a-section-title { margin-top: 24px; }
.a-fighters { display: flex; flex-wrap: wrap; gap: 8px 12px; max-width: 640px; margin: 0 0 12px; }
.a-fighters > div { flex: 1 1 250px; min-width: 0; }
.a-fighters .clade-card { width: 100%; }
.a-div { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
.a-panel { padding: 12px; border-radius: 10px; background: ${css(INK, 0.04)}; border: 1px solid ${css(INK, 0.1)}; margin: 0 0 16px; }
.a-outcome { font-size: 18px; font-weight: 650; margin: 8px 0 6px; }
.a-move { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.a-move .clade-card { animation: a-move 900ms ease-in-out both; }
.a-move[data-dir="left"] .clade-card { --a-from: 60px; }
.a-move[data-dir="right"] .clade-card { --a-from: -60px; }
@keyframes a-move { from { transform: translateX(var(--a-from, 0)); opacity: .2; } to { transform: none; opacity: 1; } }
.a-reveal .clade-cell { animation: a-in 320ms ease-out both; }
.a-reveal .clade-cell:nth-child(2) { animation-delay: 120ms; }
.a-reveal .clade-cell:nth-child(3) { animation-delay: 240ms; }
.a-reveal.theirs .clade-cell:nth-child(1) { animation-delay: 360ms; }
.a-reveal.theirs .clade-cell:nth-child(2) { animation-delay: 480ms; }
.a-reveal.theirs .clade-cell:nth-child(3) { animation-delay: 600ms; }
@keyframes a-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .a-reveal .clade-cell, .a-move .clade-card { animation: none; } }
`;
{
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------- storage
// localStorage can throw (private mode, disabled storage). A match that
// cannot be saved still plays; it just does not survive a reload.
function load(): { match: Match; seen: number } | null {
  try { return decode(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function save(): void {
  if (!match) return;
  try { localStorage.setItem(STORAGE_KEY, encode(match, seen)); } catch { /* not saved */ }
}
function clear(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}

// ---------------------------------------------------------------- state
let match: Match | null = null;
let seen = 0;
let screen: Screen | 'menu' = 'menu';
let replay: Replay | null = null;
let epoch = 0; // bumps on every screen change, so a pending computer move from a left screen is dropped

const app = document.getElementById('app')!;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...kids);
  return e;
}
function button(text: string, onClick: () => void, opts: { primary?: boolean; id?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: opts.primary ? 'a-btn primary' : 'a-btn', text });
  b.type = 'button';
  if (opts.id) b.id = opts.id;
  b.addEventListener('click', onClick);
  return b;
}

function show(name: Screen | 'menu', ...kids: Node[]): void {
  epoch++;
  replay?.destroy();
  replay = null;
  screen = name;
  document.body.dataset.screen = name;
  app.replaceChildren(...kids);
  window.scrollTo(0, 0);
}

const tagOf = (c: Creature, side: Side): Tag => (c.founder ? 'founder' : c.from !== side ? 'captured' : 'young');

function scoreBar(m: Match): HTMLElement {
  const round = m.phase === 'over' ? `Round ${m.history.length} of ${ROUNDS}` : `Round ${m.round} of ${ROUNDS}`;
  return h('div', { class: 'a-bar' },
    button('Menu', menu, { id: 'menu' }),
    h('span', { text: round }),
    h('span', { class: 'a-score', text: `You ${m.wins[HUMAN]} – ${m.wins[CPU]} Computer` }),
    h('span', { class: 'a-soft', text: `first to ${TO_WIN}` }),
  );
}

function herdGridOf(m: Match, side: Side, max: number, onChange?: (p: readonly number[]) => void): HerdGrid {
  const herd = m.herds[side];
  return herdGrid(herd.map(c => c.g), {
    max, size: 48, tags: herd.map(c => tagOf(c, side)), onChange,
    label: side === HUMAN ? 'Your herd' : "The computer's herd",
  });
}

function herdsSection(m: Match, mine?: HerdGrid): HTMLElement {
  const col = (side: Side, grid: HerdGrid) => {
    const s = h('section', { class: 'a-herd' },
      h('h3', { text: `${side === HUMAN ? 'Your herd' : "The computer's herd"} (${m.herds[side].length})` }), grid.element);
    s.dataset.side = side === HUMAN ? 'human' : 'computer';
    return s;
  };
  return h('div', { class: 'a-cols' }, col(HUMAN, mine ?? herdGridOf(m, HUMAN, 0)), col(CPU, herdGridOf(m, CPU, 0)));
}

// ---------------------------------------------------------------- menu
function menu(): void {
  const saved = match && match.phase !== 'over' ? match : null;
  const items: Node[] = [];
  if (saved) items.push(button(`Continue match (round ${saved.round})`, resume, { primary: true, id: 'continue' }));
  items.push(button(saved ? 'New match against the computer' : 'Play the computer', newGame, { primary: !saved, id: 'play' }));
  items.push(button('How to play', howto, { id: 'howto' }));
  items.push(button('What is faked', faked, { id: 'faked' }));
  show('menu',
    h('h1', { text: 'A' }),
    h('p', { class: 'a-soft', text: 'One match against the computer. Best of seven rounds.' }),
    h('div', { class: 'a-menu' }, ...items),
  );
}

function newGame(): void {
  const q = Number(new URLSearchParams(location.search).get('seed'));
  const seed = Number.isInteger(q) && q > 0 && q <= 0xffffffff ? q : crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  match = newMatch(seed);
  seen = 0;
  save();
  resume();
}

function resume(): void {
  if (!match) return menu();
  const s = screenOf(match, seen);
  if (s === 'breed') breedScreen(match);
  else if (s === 'field') fieldScreen(match);
  else if (s === 'fight') fightScreen(match);
  else endScreen(match);
}

// ---------------------------------------------------------------- how to play (variant directions §3.9)
function howto(): void {
  openHowto({
    title: 'How to play',
    paragraphs: ['You and your opponent each keep a herd. Both herds are always visible.', 'Each round:'],
    steps: [
      'Choose two of your creatures. They have three young.',
      "Both players' young are shown to both players.",
      'Choose one of your young to fight. Your opponent chooses at the same time. The other two are released.',
      'The creature that loses joins the winner\'s herd.',
    ],
    after: [
      'The first to win four rounds wins. After seven rounds, most wins.',
      "Young inherit one of each parent's two copies of every body part. When the parents' parts are very different, a young animal may grow a part that neither parent had.",
    ],
  });
}

function faked(): void {
  const o = openHowto({
    title: 'What is faked',
    paragraphs: ['This is a playable slice. Some of it stands in for the real thing:'],
    steps: [
      'The five founders are random creatures, not the real animals they will be.',
      'The match seed is chosen by this browser, and the computer opponent runs in this browser.',
      `Above ${HERD_LIMIT} creatures, the oldest non-founder is released automatically. There is no screen to choose.`,
      'Play against a person is not built yet.',
      'No sounds are tied to the game yet. The sound control works.',
    ],
    after: ['Your match is kept in this browser, so a reload continues it.'],
  });
  o.element.querySelector('.clade-counters')?.remove();
}

// ---------------------------------------------------------------- computer "thinking"
function think(text: string, el: HTMLElement, then: () => void): void {
  const mine = epoch;
  el.textContent = text;
  document.body.dataset.thinking = '1';
  setTimeout(() => {
    delete document.body.dataset.thinking;
    if (mine !== epoch) return;
    then();
  }, thinkMs(Math.random()));
}

// ---------------------------------------------------------------- breed
function breedScreen(m: Match): void {
  const pairBox = h('div', { class: 'a-pair' });
  const divLine = h('p', { class: 'a-div' });
  const thinking = h('p', { class: 'a-think' });
  const go = button('Breed these two', () => {
    const p = grid.picked();
    if (p.length !== 2) return;
    go.disabled = true;
    grid.setDisabled(m.herds[HUMAN].map((_, i) => i));
    think('The computer is choosing its parents…', thinking, () => {
      breedRound(m, [p[0], p[1]]);
      save();
      fieldScreen(m);
    });
  }, { primary: true, id: 'breed' });
  go.disabled = true;

  const onChange = (p: readonly number[]) => {
    go.disabled = p.length !== 2;
    pairBox.replaceChildren();
    if (p.length < 2) {
      divLine.textContent = p.length === 0 ? 'Tap two of your creatures.' : 'Tap one more.';
      divLine.dataset.value = '';
      for (const i of p) pairBox.append(creatureCard(m.herds[HUMAN][i].g, { size: 128, tag: tagOf(m.herds[HUMAN][i], HUMAN) }).element);
      return;
    }
    const [a, b] = [m.herds[HUMAN][p[0]], m.herds[HUMAN][p[1]]];
    const d = divergence(a.g, b.g);
    divLine.textContent = `Divergence of this pair: ${Math.round(d)}`;
    divLine.dataset.value = String(Math.round(d));
    pairBox.append(creatureCard(a.g, { size: 128, tag: tagOf(a, HUMAN) }).element, creatureCard(b.g, { size: 128, tag: tagOf(b, HUMAN) }).element);
  };
  const grid = herdGridOf(m, HUMAN, 2, onChange);
  onChange([]);

  const kids: Node[] = [scoreBar(m), h('h2', { text: 'Choose two parents' })];
  const rel = m.released;
  if (rel[HUMAN].length || rel[CPU].length) {
    const part = (side: Side) => rel[side].length
      ? `${side === HUMAN ? 'From your herd' : "From the computer's herd"}: ${rel[side].map(c => label(c.g)).join('; ')}.`
      : '';
    const note = h('p', { class: 'a-note', text: `Herd limit is ${HERD_LIMIT}. The oldest non-founders were released. ${part(HUMAN)} ${part(CPU)}`.trim() });
    note.id = 'herd-limit';
    kids.push(note);
  }
  kids.push(
    h('div', { class: 'a-panel' }, divLine, pairBox, h('div', { class: 'a-actions' }, go, thinking)),
    herdsSection(m, grid),
  );
  show('breed', ...kids);
}

// ---------------------------------------------------------------- the young, and fielding
function litterGrid(m: Match, side: Side, max: number, onChange?: (p: readonly number[]) => void): HerdGrid {
  const young = m.litters![side];
  const [i, j] = m.pairs![side];
  const parents = parentsLine(m.herds[side][i].g, m.herds[side][j].g);
  return herdGrid(young.map(y => y.g), {
    max, size: 128, tags: young.map(() => 'young' as const), onChange,
    lines: young.map(y => [parents, ...birthSentences(y.fusions)]),
    label: side === HUMAN ? 'Your young' : "The computer's young",
  });
}

function fieldScreen(m: Match): void {
  const thinking = h('p', { class: 'a-think' });
  const go = button('Fight with this one', () => {
    const p = mine.picked();
    if (p.length !== 1) return;
    go.disabled = true;
    mine.setDisabled([0, 1, 2]);
    think('The computer is choosing its fighter…', thinking, () => {
      fieldRound(m, p[0]);
      save();
      fightScreen(m);
    });
  }, { primary: true, id: 'field' });
  go.disabled = true;
  const mine = litterGrid(m, HUMAN, 1, p => { go.disabled = p.length !== 1; });
  const theirs = litterGrid(m, CPU, 0);
  const sec = (title: string, g: HerdGrid, cls: string, side: string) => {
    const s = h('section', { class: `a-litter a-reveal ${cls}` }, h('h3', { text: title }), g.element);
    s.dataset.side = side;
    return s;
  };
  show('field',
    scoreBar(m),
    h('h2', { text: 'The young' }),
    h('p', { class: 'a-soft', text: "Both litters are shown to both players. Choose one of your young to fight; the computer chooses at the same time. The other two are released." }),
    h('div', { class: 'a-actions a-sticky' }, go, thinking),
    h('div', { class: 'a-cols' }, sec('Your young', mine, 'mine', 'human'), sec("The computer's young", theirs, 'theirs', 'computer')),
    h('h3', { class: 'a-section-title', text: 'Herds' }),
    herdsSection(m),
  );
}

// ---------------------------------------------------------------- fight, capture
function fightScreen(m: Match): void {
  const r = m.history[seen];
  const [a, b] = r.fighters;
  const rec = fightEvents(stats(express(a)), stats(express(b)));
  const expected = rec.result > 0 ? 0 : rec.result < 0 ? 1 : null;
  if (expected !== r.winner) console.error(`replay disagrees with the rules in round ${r.round}`);
  const actions = rec.events.filter(e => e.kind === 'strike').length;
  const stage = h('div');
  const after = h('div');
  const nameA = `your ${label(a)}`, nameB = `computer's ${label(b)}`;
  const bar = scoreBarAt(m, r.round, seen);
  show('fight',
    bar,
    h('h2', { text: `Round ${r.round}: the fight` }),
    h('div', { class: 'a-fighters' },
      h('div', {}, h('h3', { text: 'Your fighter' }), creatureCard(a, { size: 48, tag: 'young' }).element),
      h('div', {}, h('h3', { text: "The computer's fighter" }), creatureCard(b, { size: 48, tag: 'young' }).element)),
    stage, after,
  );
  const rp = mountReplay(stage, rec, { names: { A: nameA, B: nameB }, stepMs: replayStepMs(actions) });
  replay = rp;
  const mine = epoch;
  rp.finished.then(() => {
    if (mine !== epoch) return;
    document.body.dataset.fightDone = String(r.round);
    const text = r.winner === null ? 'A drawn fight. Nobody scores, and both fighters go home.'
      : r.winner === HUMAN ? 'You win the round.' : 'The computer wins the round.';
    const kids: Node[] = [h('p', { class: 'a-outcome', text })];
    if (r.winner !== null) {
      const loser = r.winner === HUMAN ? b : a;
      const line = r.winner === HUMAN
        ? `The computer's ${label(loser)} lost and joins your herd.`
        : `Your ${label(loser)} lost and joins the computer's herd.`;
      const move = h('div', { class: 'a-move' }, creatureCard(loser, { size: 48, tag: 'captured' }).element, h('span', { text: line }));
      move.dataset.dir = r.winner === HUMAN ? 'left' : 'right';
      move.id = 'capture';
      kids.push(move);
    }
    bar.replaceWith(scoreBarAt(m, r.round, seen + 1));
    kids.push(h('div', { class: 'a-actions' }, button('Continue', () => {
      seen = Math.min(m.history.length, r.round);
      save();
      resume();
    }, { primary: true, id: 'continue-round' })));
    after.replaceChildren(...kids);
  });
}

// The score over the first `count` rounds: before the fight being shown while it plays, so the bar does not give
// the result away, and including it once the replay has ended.
function scoreBarAt(m: Match, round: number, count: number): HTMLElement {
  const wins: [number, number] = [0, 0];
  for (const x of m.history.slice(0, count)) if (x.winner !== null) wins[x.winner]++;
  return h('div', { class: 'a-bar' },
    button('Menu', menu, { id: 'menu' }),
    h('span', { text: `Round ${round} of ${ROUNDS}` }),
    h('span', { class: 'a-score', text: `You ${wins[HUMAN]} – ${wins[CPU]} Computer` }),
    h('span', { class: 'a-soft', text: `first to ${TO_WIN}` }),
  );
}

// ---------------------------------------------------------------- match end
function endScreen(m: Match): void {
  const res = m.result!;
  const title = res.winner === null ? 'A draw' : res.winner === HUMAN ? 'You win the match' : 'The computer wins the match';
  const why = res.by === 'wins'
    ? `Round wins: you ${res.wins[HUMAN]}, the computer ${res.wins[CPU]}.`
    : res.by === 'herd'
      ? `Round wins were level at ${res.wins[HUMAN]}. The larger herd wins: yours ${res.herds[HUMAN]}, the computer's ${res.herds[CPU]}.`
      : `Round wins were level at ${res.wins[HUMAN]}, and so were the herds at ${res.herds[HUMAN]}.`;
  show('over',
    scoreBar(m),
    h('h1', { text: title }),
    h('p', { text: why }),
    h('p', { class: 'a-soft', text: `${m.history.length} rounds played.` }),
    h('div', { class: 'a-actions' }, button('New match', newGame, { primary: true, id: 'new-match' }), button('Menu', menu)),
    herdsSection(m),
  );
}

// ---------------------------------------------------------------- start
const stored = load();
if (stored) { match = stored.match; seen = stored.seen; }
else clear();
if (match) resume();
else menu();

// For browser checks: read state, and wrap play() to see which cues fire.
(globalThis as unknown as { clade: object }).clade = {
  audio,
  a: {
    get state() {
      return match ? { screen, seed: match.seed, round: match.round, phase: match.phase, seen, wins: [...match.wins],
        herds: [match.herds[0].length, match.herds[1].length], released: [match.released[0].length, match.released[1].length],
        result: match.result } : { screen };
    },
  },
};
