// Variant A's tier 1 session: one match against the computer, kept in the
// browser as (seed, decisions). Workshop issue #62, build plan 2026-09-15 A2.
//
// DOM-free, so tests/a-client.test.ts drives it under Node. main.ts owns the
// screens and localStorage; this file owns what is stored, how a stored match
// is checked and resumed, and the computer's moves.
//
// The rules are server/a/rules.ts (one implementation, bundled here). The
// human is side 0 and the computer side 1. The computer reads the public view
// only and gets its own seed, derived exactly as tests/a-rules.test.ts derives
// it. Faked in tier 1, by design: the seed lives in this browser.

import {
  newMatch, view, applyBreed, applyField, validPair, validField, streamSeed, STREAM, decisions,
} from '../../server/a/rules.ts';
import type { Match, Pair, Side } from '../../server/a/rules.ts';
import { choosePair, chooseField } from '../../server/a/computer.ts';

export const HUMAN: Side = 0;
export const CPU: Side = 1;
export const STORAGE_KEY = 'clade.a.match';

export const cpuSeed = (seed: number): number => streamSeed(seed, STREAM.computer, 0, CPU);
export const computerPair = (m: Match): Pair => choosePair(view(m), CPU, cpuSeed(m.seed));
export const computerField = (m: Match): number => chooseField(view(m), CPU, cpuSeed(m.seed));

/** The human's parents and the computer's, applied together. Throws on an illegal human pair. */
export function breedRound(m: Match, human: Pair): Match {
  if (!validPair(m, HUMAN, human)) throw new Error('illegal pair');
  return applyBreed(m, [[human[0], human[1]], computerPair(m)]);
}

/** The human's fighter and the computer's, applied together: fight, capture, release. */
export function fieldRound(m: Match, human: number): Match {
  if (!validField(human)) throw new Error('illegal field');
  return applyField(m, [human, computerField(m)]);
}

/**
 * What the player should be looking at. `seen` counts the rounds whose fight
 * has been shown to the end, so a reload during a replay shows that fight
 * again rather than skipping to the next round.
 */
export type Screen = 'breed' | 'field' | 'fight' | 'over';
export function screenOf(m: Match, seen: number): Screen {
  if (m.history.length > seen) return 'fight';
  return m.phase;
}

export type Stored = { v: 1; seed: number; decisions: ReturnType<typeof decisions>; seen: number };

export function encode(m: Match, seen: number): string {
  const s: Stored = { v: 1, seed: m.seed, decisions: decisions(m), seen };
  return JSON.stringify(s);
}

/**
 * A stored match, replayed and checked: every human move must be legal and
 * every computer move must be the one the computer makes. Anything else
 * (absent, corrupt, edited, from an older format) is null, never a throw.
 */
export function decode(text: string | null | undefined): { match: Match; seen: number } | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 20000) return null;
  let s: unknown;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || typeof s !== 'object') return null;
  const o = s as Partial<Stored>;
  if (o.v !== 1 || !Number.isInteger(o.seed) || (o.seed as number) < 0 || (o.seed as number) > 0xffffffff) return null;
  if (!Array.isArray(o.decisions) || !Number.isInteger(o.seen)) return null;
  const m = newMatch(o.seed as number);
  const log = o.decisions;
  for (let i = 0; i < log.length; i++) {
    const d = log[i] as { pairs?: unknown; fields?: unknown };
    if (m.phase !== 'breed' || !d || typeof d !== 'object' || !Array.isArray(d.pairs) || d.pairs.length !== 2) return null;
    const [hp, cp] = d.pairs as unknown[];
    if (!validPair(m, HUMAN, hp) || !validPair(m, CPU, cp)) return null;
    const want = computerPair(m);
    if (cp[0] !== want[0] || cp[1] !== want[1]) return null;
    breedRound(m, hp);
    if (d.fields === undefined) { if (i !== log.length - 1) return null; break; }
    if (!Array.isArray(d.fields) || d.fields.length !== 2) return null;
    const [hf, cf] = d.fields as unknown[];
    if (!validField(hf) || cf !== computerField(m)) return null;
    fieldRound(m, hf);
  }
  const seen = o.seen as number;
  if (seen < 0 || seen > m.history.length) return null;
  return { match: m, seen };
}

/** Milliseconds per replay action: 300 for a typical fight, faster for a long one so none runs past about 8 s. */
export function replayStepMs(actions: number): number {
  return actions <= 26 ? 300 : Math.max(60, Math.floor(8000 / actions));
}

/** How long the computer appears to think, 0.3 to 1.5 s, from a unit draw. */
export const thinkMs = (u: number): number => 300 + Math.round(Math.max(0, Math.min(1, u)) * 1200);
