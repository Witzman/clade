// Determinism gate for core/. Workshop issues #23, #24.
//
// Runs a full deme simulation (6 zoos x 20, 20 generations, mixed breeding,
// migration by conquest) from one integer seed and hashes the final HP bits of
// EVERY fight and every genome byte of the final population. The same file
// runs under V8 (`node tests/determinism.test.ts`) and JavaScriptCore
// (`bun tests/determinism.test.ts`); CI runs both. Each must reproduce the
// golden hashes below.
//
// A plain script rather than a test-runner file, so that both engines execute
// exactly the same code with no runner in between. Exits 1 on any mismatch.
//
// If a deliberate change to core/ moves a hash, update GOLDEN in the same
// commit and say why in the commit message.

import * as C from "../core/index.ts";

const GENS = 20;
const GOLDEN: Record<number, string> = {
  20260913: "fd429d46",
  7: "18ff4957",
  424242: "b9e9967d",
};

function simulate(seed: number, gens: number) {
  const f64 = new Float64Array(1);
  const f64b = new Uint8Array(f64.buffer);
  let h = 0x811c9dc5;
  const mixByte = (b: number) => { h = Math.imul(h ^ b, 0x01000193); };
  const mixF = (x: number) => { f64[0] = x; for (let i = 0; i < 8; i++) mixByte(f64b[i]); };
  const mixG = (g: Uint8Array) => { for (let i = 0; i < g.length; i++) mixByte(g[i]); };

  const r = C.rng(seed);
  let fights = 0, ticks = 0, fusions = 0;

  const duel = (a: C.Genome, b: C.Genome) => {
    const f = C.fight(C.stats(C.express(a)), C.stats(C.express(b)));
    fights++; ticks += f.t; mixF(f.hpA); mixF(f.hpB);
    return C.fightResult(f);
  };
  const distance = (a: C.Genome, b: C.Genome) => {
    // breeding-screen "divergence": form mismatch on slot 0 + mean vec distance
    let d = 0, mm = 0;
    for (let l = 0; l < C.NL; l++) {
      if (C.form(a, l, 0) !== C.form(b, l, 0)) mm++;
      for (let s = 0; s < 2; s++) for (let x = 0; x < C.NA; x++)
        d += Math.abs(((a[(l * 2 + s) * 9 + 4 + x] << 24) >> 24) - ((b[(l * 2 + s) * 9 + 4 + x] << 24) >> 24));
    }
    return d / (C.NL * 2 * C.NA) + 42 * mm / C.NL;
  };

  let demes: C.Genome[][] = [];
  for (let d = 0; d < 6; d++) {
    const z = [0, 1, 2, 3].map(() => C.founder(r));
    while (z.length < 20) z.push(C.breed(z[C.int(r, z.length)], z[C.int(r, z.length)], r).child);
    demes.push(z);
  }

  for (let g = 1; g <= gens; g++) {
    const champs: C.Genome[] = [];
    demes = demes.map(pool => {
      const wins = pool.map((c, i) => {
        let w = 0;
        for (let k = 0; k < 7; k++) {
          let j = C.int(r, pool.length - 1); if (j >= i) j++;
          if (duel(c, pool[j]) > 0) w++;
        }
        return w;
      });
      const order = pool.map((_, i) => i).sort((a, b) => wins[b] - wins[a] || a - b);
      const winners = order.slice(0, 10).map(i => pool[i]);
      champs.push(winners[0]);
      const keep = winners.slice(0, 7);
      const kids: C.Genome[] = [];
      while (keep.length + kids.length < 20) {
        let a = C.int(r, 10), b = C.int(r, 9); if (b >= a) b++;
        if (C.unit(r) < 0.4) {
          let best = -1;
          for (let k = 0; k < 6; k++) {
            const x = C.int(r, 10); let y = C.int(r, 9); if (y >= x) y++;
            const dd = distance(winners[x], winners[y]);
            if (dd > best) { best = dd; a = x; b = y; }
          }
        }
        const { child, fusions: fu } = C.breed(winners[a], winners[b], r);
        fusions += fu.length;
        kids.push(child);
      }
      return keep.concat(kids);
    });
    for (let d = 0; d < 6; d++) for (let m = 0; m < 2; m++) {
      const e = C.int(r, 6); if (e === d) continue;
      const res = duel(champs[d], champs[e]);
      if (res === 0) continue;
      const [src, dst] = res > 0 ? [d, e] : [e, d];
      demes[dst][C.int(r, 20)] = demes[src][C.int(r, 20)].slice();
    }
  }

  demes.flat().forEach(mixG);
  return { fights, ticks, fusions, hash: (h >>> 0).toString(16).padStart(8, "0") };
}

const bun = (globalThis as { Bun?: { version: string } }).Bun;
const engine = bun ? `JavaScriptCore (bun ${bun.version})` : `V8 (node ${process.version})`;
let failed = 0;
for (const [seedText, want] of Object.entries(GOLDEN)) {
  const seed = Number(seedText);
  const got = simulate(seed, GENS);
  const ok = got.hash === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${engine}  seed=${seed} gens=${GENS} fights=${got.fights} ticks=${got.ticks} fusions=${got.fusions} hash=${got.hash} golden=${want}`);
}
if (failed) {
  console.log(`determinism: ${failed} of ${Object.keys(GOLDEN).length} seeds differ from the golden hash`);
  process.exit(1);
}
console.log(`determinism: all ${Object.keys(GOLDEN).length} seeds match under ${engine}`);
