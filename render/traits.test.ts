// Tests for the genome -> anatomy mapping. Run: node --test render/
// (Node 22 strips the types; nothing to build.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { traits, type AnatomyTraits } from "./traits.ts";
import { rng, founder, breed, GENOME_B, NL, NA, int, type Genome } from "../core/index.ts";

// The #21 functional masks: which three dimensions each system may express.
const MASK = [[0, 4, 3], [4, 3, 2], [1, 3, 0], [2, 1, 0], [3, 1, 0], [2, 0, 1],
  [2, 1, 3], [2, 3, 4], [0, 4, 1], [4, 2, 3], [3, 1, 2], [3, 0, 4]];

/** A genome that invests `amount` in exactly one dimension, wherever the masks
 *  allow it. Both alleles of a system share one form (default 0). */
function pure(dim: number, amount = 60, forms: number[] = [], tier = 2): Genome {
  const g = new Uint8Array(GENOME_B);
  for (let l = 0; l < NL; l++) for (let s = 0; s < 2; s++) {
    const o = (l * 2 + s) * 9;
    const f = l === 0 ? tier : forms[l] ?? 0;
    g[o] = f | (15 << 4);
    g[o + 2] = 7 + s; // seed
    for (let a = 0; a < NA; a++) g[o + 4 + a] = (MASK[l].includes(a) && a === dim ? amount : 0) & 255;
  }
  return g;
}

function population(seed: number, n: number): Genome[] {
  const r = rng(seed);
  const out: Genome[] = [];
  for (let i = 0; i < 40; i++) out.push(founder(r));
  while (out.length < n) out.push(breed(out[int(r, out.length)], out[int(r, out.length)], r).child);
  return out;
}

const floats = (t: AnatomyTraits) => [
  t.head.length, t.head.depth, t.head.gape, t.head.fringe, t.head.horn, t.head.eyeSize, t.head.stalks,
  t.core.length, t.core.height, t.core.chitin, t.core.dorsal, t.core.hunch,
  t.limbs.length, t.limbs.thickness, t.limbs.foot, t.limbs.splay,
  t.tail.length, t.tail.sting, t.size, t.hue, t.pattern];

test("deterministic and pure: same genome, same traits; the genome is not written", () => {
  for (const g of population(11, 200)) {
    const before = g.slice();
    const a = traits(g), b = traits(g.slice());
    assert.deepEqual(a, b);
    assert.deepEqual(g, before);
  }
});

test("every value is inside the range anatomy.ts expects", () => {
  for (const g of population(12, 3000)) {
    const t = traits(g);
    for (const x of floats(t)) assert.ok(Number.isFinite(x) && x >= 0 && x <= 1, `float ${x}`);
    assert.ok(Number.isInteger(t.head.eyes) && t.head.eyes >= 1 && t.head.eyes <= 4);
    assert.ok(Number.isInteger(t.core.segments) && t.core.segments >= 2 && t.core.segments <= 9);
    assert.ok([2, 4, 6, 8].includes(t.limbs.count));
    assert.ok(Number.isInteger(t.limbs.joints) && t.limbs.joints >= 2 && t.limbs.joints <= 4);
    assert.ok(Number.isInteger(t.tail.count) && t.tail.count >= 1 && t.tail.count <= 6);
    assert.ok(Number.isInteger(t.seed) && t.seed >= 0 && t.seed < 65536);
  }
});

// The honesty tests. Five creatures that each invest in one dimension only. The
// cue assigned to that dimension must be strongest on the creature that has it.
const [BULK, REACH, SHARP, SPEED, ARMOUR] = [0, 1, 2, 3, 4].map(d => traits(pure(d)));
const all = { BULK, REACH, SHARP, SPEED, ARMOUR };
const strongest = (cue: (t: AnatomyTraits) => number) =>
  Object.entries(all).sort((x, y) => cue(y[1]) - cue(x[1]))[0][0];

test("heavy looks heavy: the deepest body and the thickest legs", () => {
  assert.equal(strongest(t => t.core.height), "BULK");
  assert.equal(strongest(t => t.limbs.thickness), "BULK");
  assert.equal(strongest(t => t.head.depth), "BULK");
});

test("armour looks like armour: the hardest, most plated, most domed body", () => {
  assert.equal(strongest(t => t.core.chitin), "ARMOUR");
  assert.equal(strongest(t => t.core.segments), "ARMOUR");
  assert.equal(strongest(t => t.core.hunch), "ARMOUR");
});

test("quick looks quick: the longest and thinnest legs", () => {
  assert.equal(strongest(t => t.limbs.length), "SPEED");
  assert.equal(strongest(t => -t.limbs.thickness), "SPEED");
});

test("sharp is visible as sharp: the biggest spike on the outline", () => {
  assert.equal(strongest(t => Math.max(t.head.horn, t.tail.sting, t.core.dorsal)), "SHARP");
  assert.ok(Math.max(SHARP.head.horn, SHARP.tail.sting, SHARP.core.dorsal) > 0.3);
  for (const t of [BULK, REACH, SPEED, ARMOUR]) assert.equal(Math.max(t.head.horn, t.tail.sting, t.core.dorsal), 0);
});

test("long reach projects forward: the longest head", () => {
  assert.equal(strongest(t => t.head.length), "REACH");
});

test("forms place a cue but never create one: an uninvested horn draws no horn", () => {
  const horned = pure(BULK_DIM(), 60, formsWith(6, 1)); // weapon = horn, no sharpness, no reach
  assert.equal(traits(horned).head.horn, 0);
  const sharpHorn = pure(2, 60, formsWith(6, 1));
  assert.ok(traits(sharpHorn).head.horn > 0.3);
  const sharpSting = traits(pure(2, 60, formsWith(6, 2)));
  assert.ok(sharpSting.tail.sting > 0.3 && sharpSting.tail.count === 1);
});

test("allele seeds do not leak into the drawing (they re-roll every birth)", () => {
  for (const g of population(13, 300)) {
    const h = g.slice();
    for (let l = 0; l < NL; l++) for (let s = 0; s < 2; s++) { h[(l * 2 + s) * 9 + 2] ^= 0x5a; }
    // flipping seeds can change which of two equal-rank alleles is expressed;
    // only compare genomes where that does not happen
    const a = traits(g), b = traits(h);
    const { seed: _a, ...ra } = a, { seed: _b, ...rb } = b;
    if (JSON.stringify(ra) !== JSON.stringify(rb)) {
      let tie = false;
      for (let l = 0; l < NL; l++) if (g[l * 18] === g[l * 18 + 9] && g[l * 18 + 1] === g[l * 18 + 10]) tie = true;
      assert.ok(tie, "traits changed with seeds alone, and no dominance tie explains it");
    }
  }
});

test("size follows the body-size class, and bigger never draws smaller", () => {
  const sizes = [0, 1, 2, 3, 4].map(tier => traits(pure(0, 60, [], tier)).size);
  assert.deepEqual(sizes, [0, 0.25, 0.5, 0.75, 1]);
});

test("colour is heritable form, not combat: pure shapes with the same forms share a hue", () => {
  assert.equal(new Set(Object.values(all).map(t => t.hue)).size, 1);
});

function BULK_DIM() { return 0; }
function formsWith(system: number, f: number) { const fs = new Array(NL).fill(0); fs[system] = f; return fs; }
