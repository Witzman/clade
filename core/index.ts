// The shared core: pure functions over plain data. Workshop issues #23, #24.
//
// Every variant, the server and the browser run this same code, and a fight or
// a birth must come out bit-identical in V8 (Chrome, Node) and JavaScriptCore
// (Safari, every iPad browser). So core/ is held to three rules, enforced in CI
// rather than by this comment:
//
//   - Only arithmetic that ECMA-262 pins to exact IEEE-754 binary64 results:
//     + - * /, square root, rounding, abs/min/max, and 32-bit integer ops.
//     The transcendental functions (powers, exponentials, logarithms,
//     trigonometry, hypot, cbrt) are implementation-approximated
//     and differ between engines in the last bit. tests/core-purity.sh names
//     them and fails the build on any use.
//   - No IO, no DOM, no clock, no engine randomness. Randomness is an Rng the
//     caller passes in.
//   - No import from outside core/.
//
// tests/determinism.test.ts hashes a full simulation over three seeds and
// asserts committed golden hashes under Node and Bun. A change to core/ that
// moves a hash changes the golden value in the same commit, with the reason in
// the commit message.
//
// A variant that needs a different rule copies the function into its own
// directory and changes the copy. core/ takes no options, flags or callbacks.

export { rng, u32, unit, int, uniform, normal } from "./rng.ts";
export type { Rng } from "./rng.ts";
export { NL, NA, NM, BULK, REACH, SHARP, SPEED, ARMOUR, ALLELE_B, GENOME_B, SYSTEMS, FORMS, form, graft } from "./genome.ts";
export type { Genome } from "./genome.ts";
export { express, stats } from "./express.ts";
export type { Phenotype, Stats } from "./express.ts";
export { fightStart, fightStep, fightResult, fight } from "./fight.ts";
export type { FightState } from "./fight.ts";
export { breed, founder } from "./breed.ts";
export type { Fusion } from "./breed.ts";
export { label } from "./label.ts";
