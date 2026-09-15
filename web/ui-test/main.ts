// /ui-test: the shared presentation in ui/, on real genomes. Workshop issue #61.
//
// Everything is founded and bred by core/ from the seed (?seed=N, default 1, so
// a screenshot is repeatable). The page states nothing about any variant's
// rules; it exists so the card, the birth lines, the grid and the overlay can
// be looked at on staging at desktop, iPad and phone width.

import { sharedAudio } from '../../audio/index.ts';
import { mountAudioControl } from '../../audio/control.ts';
import { breed, founder, label, rng, type Fusion, type Genome } from '../../core/index.ts';
import { birthSentences, parentsLine } from '../../ui/birth.ts';
import { creatureCard } from '../../ui/card.ts';
import { herdGrid } from '../../ui/grid.ts';
import { openHowto } from '../../ui/howto.ts';

const $ = (id: string) => document.getElementById(id)!;

async function run(): Promise<void> {
  // The sound control is mounted so the overlay is checked against it: the top-right corner stays clear.
  mountAudioControl(sharedAudio());

  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) >>> 0 || 1;
  $('seedinfo').textContent = `seed ${seed}`;
  ($('reroll') as HTMLAnchorElement).href = `?seed=${(Math.random() * 0xffffffff) >>> 0}`;

  const r = rng(seed);
  const founders: Genome[] = [];
  for (let i = 0; i < 5; i++) founders.push(founder(r));
  const litter: { child: Genome; fusions: Fusion[] }[] = [0, 1, 2].map(() => breed(founders[0], founders[1], r));
  const captured = founder(rng(seed ^ 0x9e3779b9));
  const youngLines = litter.map((b) => [parentsLine(founders[0], founders[1]), ...birthSentences(b.fusions)]);

  const readies: Promise<void>[] = [];
  const cards = [
    creatureCard(founders[0], { tag: 'founder' }),
    creatureCard(founders[1], { tag: 'founder' }),
    ...litter.map((b, i) => creatureCard(b.child, { tag: 'young', lines: youngLines[i] })),
    creatureCard(captured, { tag: 'captured' }),
  ];
  for (const c of cards) { $('cards').append(c.element); readies.push(c.ready); }

  const herd = [...founders, ...litter.map((b) => b.child), captured];
  const herdTags = [...founders.map(() => 'founder' as const), ...litter.map(() => 'young' as const), 'captured' as const];
  const grid = herdGrid(herd, {
    max: 2, tags: herdTags, label: 'Herd',
    onChange: (p) => { $('picked').textContent = p.length ? `Picked: ${p.map((i) => label(herd[i])).join(' + ')}` : 'Picked: none'; },
  });
  $('herd').append(grid.element);
  readies.push(grid.ready);

  const litterGrid = herdGrid(litter.map((b) => b.child), {
    max: 1, size: 128, tags: litter.map(() => 'young' as const), lines: youngLines, label: 'Litter',
    onChange: (p) => { $('fielded').textContent = p.length ? `Picked: ${label(litter[p[0]].child)}` : 'Picked: none'; },
  });
  $('litter').append(litterGrid.element);
  readies.push(litterGrid.ready);

  for (const g of herd.slice(0, 4)) $('small').append(creatureCard(g, { size: 48, tag: 'founder' }).element);
  for (const g of herd.slice(4, 8)) $('small').append(creatureCard(g, { size: 32 }).element);

  $('howto').addEventListener('click', () => {
    openHowto({
      title: 'How to play',
      paragraphs: ['This is the shared overlay shell. Each variant supplies its own words here.'],
      steps: ['A first step.', 'A second step, long enough to wrap onto a second line at phone width.', 'A third step.'],
      after: ['A closing paragraph.'],
    });
  });

  (window as unknown as { uiTest: unknown }).uiTest = { seed, grid, litterGrid, fusions: litter.map((b) => b.fusions.length) };
  await Promise.all(readies);
  document.body.dataset.done = '1';
}

run().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const el = $('error');
  el.textContent = `UI test failed: ${msg}`;
  el.hidden = false;
  console.error(e);
});
