// Tests for the birth sentences (ui/birth.ts) and the shared wording
// (ui/words.ts). Run: node --test tests/ui-birth.test.ts
//
// A birth card that prints "undefined", "NaN" or nothing is the model made
// invisible at the one moment a player is looking, so every record the core
// can produce has to give a real sentence: every system and form pair
// exhaustively, and then the fusions real breeding actually makes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMS, NA, NL, NM, SYSTEMS, breed, founder, int, label, rng } from "../core/index.ts";
import type { Fusion, Genome } from "../core/index.ts";
import { birthSentences, fusionSentence, parentsLine } from "../ui/birth.ts";
import { COUNTERS_TEXT, COUNTERS_TITLE, DIMENSIONS } from "../ui/words.ts";

function assertText(s: string, what: string) {
  assert.equal(typeof s, "string", what);
  assert.ok(s.trim().length > 0, `${what}: empty`);
  assert.doesNotMatch(s, /undefined|null|NaN|Infinity|\[object/, `${what}: ${s}`);
  assert.doesNotMatch(s, /\s{2,}|\s[.,;:]/, `${what}: stray whitespace in ${s}`);
  assert.match(s, /\.$/, `${what}: no full stop: ${s}`);
}

test("every system, form pair, dimension pair and size of difference gives a sentence", () => {
  let n = 0;
  for (let system = 0; system < NL; system++)
    for (let formA = 0; formA < NM; formA++)
      for (let formB = 0; formB < NM; formB++)
        for (let disputed = 0; disputed < NA; disputed++)
          for (let moved = 0; moved < NA; moved++)
            for (const by of [0, 0.4, 0.6, 17.5, 42, 199.9]) {
              const f: Fusion = { system, formA, formB, disputed, moved, by };
              const s = fusionSentence(f);
              assertText(s, JSON.stringify(f));
              assert.ok(s.startsWith(`${SYSTEMS[system]}: ${FORMS[system][formA]} met ${FORMS[system][formB]}.`), s);
              assert.ok(s.includes(DIMENSIONS[moved]), `moved dimension missing: ${s}`);
              if (Math.round(by) > 0) assert.ok(s.includes(`by ${Math.round(by)}, most about ${DIMENSIONS[disputed]}`), s);
              n++;
            }
  assert.equal(n, NL * NM * NM * NA * NA * 6);
});

test("a record the core cannot produce is refused, not printed", () => {
  const ok: Fusion = { system: 0, formA: 0, formB: 1, disputed: 0, moved: 1, by: 10 };
  for (const bad of [{ system: NL }, { system: -1 }, { formA: NM }, { formB: 1.5 }, { disputed: NA }, { moved: -1 }, { by: NaN }]) {
    assert.throws(() => fusionSentence({ ...ok, ...bad } as Fusion), RangeError, JSON.stringify(bad));
  }
});

test("a birth with no fusion still has a line", () => {
  assert.deepEqual(birthSentences([]), ["No parts fused."]);
});

test("real breeding: every fusion in 3000 births gives a sentence, and every system is seen fusing", () => {
  const seen = new Set<number>();
  let fusions = 0, plain = 0;
  for (let seed = 1; seed <= 3; seed++) {
    const r = rng(seed * 7919);
    const pool: Genome[] = [];
    for (let i = 0; i < 30; i++) pool.push(founder(r));
    for (let i = 0; i < 1000; i++) {
      const a = pool[int(r, pool.length)], b = pool[int(r, pool.length)];
      const { child, fusions: fs } = breed(a, b, r);
      const lines = birthSentences(fs);
      assert.equal(lines.length, Math.max(1, fs.length));
      lines.forEach((s, k) => assertText(s, `seed ${seed} birth ${i} line ${k}`));
      assertText(parentsLine(a, b), "parents line");
      assertText(label(child) + ".", "label");
      for (const f of fs) seen.add(f.system);
      fusions += fs.length;
      if (fs.length === 0) plain++;
      pool.push(child);
    }
  }
  console.log(`# ${fusions} fusions, ${plain} births without one, systems fused: ${seen.size}/${NL}`);
  assert.ok(fusions > 0 && plain > 0, "both kinds of birth card were exercised");
  assert.equal(seen.size, NL, `systems never seen fusing: ${[...Array(NL).keys()].filter(l => !seen.has(l))}`);
});

test("the counters panel wording is exactly variant directions §1.4", () => {
  assert.equal(COUNTERS_TITLE, "What beats what.");
  assert.equal(COUNTERS_TEXT,
    "Armour stops sharp weapons and softens every blow. A heavy animal cannot land a blow on a quick one. " +
    "Quick, light attacks do not trouble a heavy animal. Sharp parts also cut whoever attacks them. " +
    "The longer reach strikes first.");
});
