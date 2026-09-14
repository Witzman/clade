// A run: the player's own creatures, derived from a seed and a decision log.
// Workshop issue #25 (technical plan §5.1, §5.4).
//
// Pure, and imported by both the server and the browser client. The browser
// derives its herd from (runSeed, decisions) and sends a hash of the result;
// the server replays the same log with the same core and compares. A match
// means the herd is exactly what that seed and those decisions produce -- no
// signature and no stored state. A mismatch is either tampering or
// cross-engine drift, and the server logs it (LOG_DESYNC=1).
//
// This is the throwaway test room's run, not a variant's. A variant owns its
// own run shape.

import { rng, founder, breed, GENOME_B } from "../../core/index.ts";
import type { Genome } from "../../core/index.ts";

export const FOUNDERS = 4;
export const HERD = 3;
export const MAX_DECISIONS = 400;

export type Decision = [number, number];

export type Replayed = { zoo: Genome[]; herd: Genome[]; hash: string };

// FNV-1a over bytes, as 8 hex digits. Not cryptographic: it detects drift and
// casual edits, which is all a POC without accounts needs.
export function fnv(bytes: ArrayLike<number>, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
export const hex8 = (h: number) => (h >>> 0).toString(16).padStart(8, "0");

export function toHex(g: Genome): string {
  let s = "";
  for (let i = 0; i < g.length; i++) s += g[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: unknown): Genome | null {
  if (typeof s !== "string" || s.length !== GENOME_B * 2 || !/^[0-9a-f]+$/.test(s)) return null;
  const g = new Uint8Array(GENOME_B);
  for (let i = 0; i < GENOME_B; i++) g[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return g;
}

// Validates the shape of an untrusted log. Returns null when it is malformed.
export function checkDecisions(d: unknown): Decision[] | null {
  if (!Array.isArray(d) || d.length > MAX_DECISIONS) return null;
  const out: Decision[] = [];
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const size = FOUNDERS + i;
    if (!Array.isArray(x) || x.length !== 2) return null;
    const [a, b] = x;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= size || b >= size) return null;
    out.push([a, b]);
  }
  return out;
}

export function replay(runSeed: number, decisions: Decision[]): Replayed {
  const r = rng(runSeed);
  const zoo: Genome[] = [];
  for (let i = 0; i < FOUNDERS; i++) zoo.push(founder(r));
  for (const [a, b] of decisions) zoo.push(breed(zoo[a], zoo[b], r).child);
  let h = 0x811c9dc5;
  for (const g of zoo) h = fnv(g, h);
  return { zoo, herd: zoo.slice(-HERD), hash: hex8(h) };
}

// A run the page (and the computer seat) can play without a breeding screen:
// every creature so far bred with the next one, until the herd is all young.
export function autoDecisions(n = 3): Decision[] {
  const d: Decision[] = [];
  for (let i = 0; i < n; i++) d.push([i, i + 1]);
  return d;
}
