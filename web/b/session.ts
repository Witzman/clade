// Variant B's tier 1 session: one expedition against the computer expedition,
// kept in the browser as (seed, decisions). Workshop issue #65, build plan
// 2026-09-15 piece B2.
//
// DOM-free, so tests/b-client.test.ts drives it under Node. main.ts owns the
// screens and localStorage; this file owns what is stored, how a stored run is
// checked and resumed, and which fights are still to be shown.
//
// The rules are web/b/run.ts (B1, #63) and nothing here decides an outcome.
// Faked in tier 1, by design: the run seed lives in this browser.

import { PLAYER, replay, type Creature, type Decision, type FightRecord, type Run } from './run.ts';
import { isCrossing, type Limit } from './base.ts';

export const STORAGE_KEY = 'clade.b.run';

/** The weight limits in the words the player reads. */
export const LIMIT_WORDS: Record<Limit, string> = {
  'any': 'any size',
  'medium-or-smaller': 'medium or smaller',
  'small-or-smaller': 'small or smaller',
  'medium-or-larger': 'medium or larger',
  'big-or-larger': 'big or larger',
};

/** One fight the player has taken part in, with both creatures resolved from their ids. */
export interface ShownFight {
  index: number;
  stop: number;
  crossing: boolean;
  mine: Creature;
  theirs: Creature;
  rec: FightRecord;
}

/**
 * Every fight of the player's run, oldest first.
 *
 * `run.fights` is re-pointed (not emptied) when the next lineup starts, and the
 * finished StopRecord keeps the old array, so the live array may only be added
 * while a lineup is open — during `breed` it is still the previous stop's.
 */
export function fightsOf(run: Run): ShownFight[] {
  const out: ShownFight[] = [];
  const add = (stop: number, crossing: boolean, mine: readonly Creature[], theirs: readonly Creature[], fights: readonly FightRecord[]) => {
    for (const rec of fights) {
      const a = mine.find(c => c.id === rec.mine);
      const b = theirs.find(c => c.id === rec.theirs);
      if (a && b) out.push({ index: out.length, stop, crossing, mine: a, theirs: b, rec });
    }
  };
  for (const s of run.exps[PLAYER].stops) add(s.stop, s.crossing, s.lineup, s.opponent, s.fights);
  if ((run.phase === 'lineup' || run.phase === 'answer') && run.brought && run.opponent) {
    add(run.stop, isCrossing(run.stop), run.brought, run.opponent, run.fights);
  }
  return out;
}

/**
 * What the player should be looking at. `seen` counts the fights whose replay
 * has been played to the end, so a reload during a replay shows that fight
 * again rather than skipping past it.
 */
export type Screen = 'founders' | 'breed' | 'keep' | 'release' | 'lineup' | 'answer' | 'fight' | 'over';
export function screenOf(run: Run, seen: number): Screen {
  if (seen < fightsOf(run).length) return 'fight';
  return run.phase;
}

export interface Stored { v: 1; seed: number; log: Decision[]; seen: number }

export function encode(run: Run, seen: number): string {
  const s: Stored = { v: 1, seed: run.seed, log: run.log, seen };
  return JSON.stringify(s);
}

/**
 * A stored run, replayed and checked: the seed must be a real seed and every
 * decision must be legal at the point it is applied (web/b/run.ts `replay`
 * revalidates the whole log). Anything else — absent, corrupt, edited, from an
 * older format — is null, never a throw.
 */
export function decode(text: string | null | undefined): { run: Run; seen: number } | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 20000) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Partial<Stored>;
  if (o.v !== 1) return null;
  if (!Number.isInteger(o.seed) || (o.seed as number) < 0 || (o.seed as number) > 0xffffffff) return null;
  if (!Number.isInteger(o.seen) || (o.seen as number) < 0) return null;
  const run = replay(o.seed as number, o.log);
  if (!run) return null;
  if ((o.seen as number) > fightsOf(run).length) return null;
  return { run, seen: o.seen as number };
}

/**
 * Milliseconds per replay action: 300 for a typical fight, faster for a long
 * one so none runs past about 8 s. A fork of variant A's rule, not an import:
 * variants never import each other.
 */
export function replayStepMs(actions: number): number {
  return actions <= 26 ? 300 : Math.max(60, Math.floor(8000 / actions));
}
