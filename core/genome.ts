// The genome layout and the model's constant tables. Workshop issues #21, #23.
//
// A genome is a Uint8Array(216): 12 body systems x 2 alleles x 9 bytes.
//
// Where the reference model raises body mass to a power, the argument has only
// five possible values (body-size class), so the results are literal tables,
// generated once in Python and pasted as decimal literals -- literal parsing IS
// exactly specified, the engine's power function is not.

export const NL = 12; // body systems
export const NA = 5; // BULK, REACH, SHARPNESS, SPEED, ARMOUR
export const NM = 5; // forms per system
export const BULK = 0, REACH = 1, SHARP = 2, SPEED = 3, ARMOUR = 4;
export const ALLELE_B = 9;
export const GENOME_B = NL * 2 * ALLELE_B; // 216
export const NO_GRAFT = 15;
export const SIZE_L = 0;
export const VMAX = 100;

// ---------------------------------------------------------------- tables
export const SYSTEMS = ["size", "skin", "body", "front limbs", "back limbs", "head",
  "weapon", "spray", "frame", "covering", "senses", "body heat"];
export const FORMS: string[][] = [
  ["tiny", "small", "medium", "big", "huge"],
  ["shell", "scales", "hide", "fur", "feathers"],
  ["two legs", "four legs", "long body", "spoke body", "wings"],
  ["pincers", "hands", "flippers", "wing arms", "grabbing arms"],
  ["running legs", "flat feet", "jumping legs", "tail fin", "gripping claws"],
  ["biting jaws", "beak", "heavy jaw", "long snout", "rasping tongue"],
  ["fangs", "horn", "stinger", "tusks", "spurs"],
  ["venom", "ink", "slime", "acid", "glue"],
  ["hard case", "bony plates", "inner bones", "water-filled", "gristle"],
  ["spines", "bristles", "horn plates", "colour-change skin", "fine hairs"],
  ["many-lens eyes", "echo hearing", "water sense", "feelers", "heat pits"],
  ["warm-blooded", "cold-blooded", "holds heat", "air sacs", "gills"],
];
export const DOM: number[][] = [
  [4, 6, 7, 5, 3], [6, 5, 4, 3, 2], [4, 6, 3, 2, 5], [5, 4, 3, 4, 7],
  [4, 3, 6, 3, 5], [6, 5, 6, 2, 3], [6, 5, 7, 5, 3], [4, 7, 5, 2, 4],
  [6, 5, 6, 2, 1], [5, 3, 3, 5, 2], [4, 5, 3, 4, 5], [6, 4, 5, 1, 3],
];
export const MASK_IDX: number[][] = [
  [BULK, ARMOUR, SPEED], [ARMOUR, SPEED, SHARP], [REACH, SPEED, BULK],
  [SHARP, REACH, BULK], [SPEED, REACH, BULK], [SHARP, BULK, REACH],
  [SHARP, REACH, SPEED], [SHARP, SPEED, ARMOUR], [BULK, ARMOUR, REACH],
  [ARMOUR, SHARP, SPEED], [SPEED, REACH, SHARP], [SPEED, BULK, ARMOUR],
];
export const MASK: boolean[][] = MASK_IDX.map(ix => [0, 1, 2, 3, 4].map(a => ix.includes(a)));

// MASS_RATIO = [0.50, 0.75, 1.00, 1.25, 1.50]; python: repr(m ** e)
// Generated, not typed: python3 -c "print([m**0.75 for m in (0.5,0.75,1,1.25,1.5)])".
// A hand-typed first version of these tables was wrong in six places.
export const KLEIBER = [0.5946035575013605, 0.8059274488676564, 1.0, 1.1821770112539698, 1.3554030054147672]; // ^0.75
export const SPEED_POW = [1.624504792712471, 1.2230863395232023, 1.0, 0.8553876799929504, 0.752897956971237]; // ^-0.70
export const COST_POW = [0.7955364837549187, 0.9094319693204537, 1.0, 1.076416395917566, 1.1431681486535354]; // ^0.33

export const P = {
  budget_base: 314.0, fuse_t0: 18.0, fuse_t1: 80.0, fuse_pmax: 0.45, fuse_gain: 1.0,
  fuse_vigour: 1.03, morph_tension: 42.0, inbreed: 0.40, mut_p: 0.060, mut_morph_p: 0.022,
};
export const CB = {
  hp_base: 71.2021, hp_l1: 0.35, hp_m: 0.20, kE: 1.35, kM: 0.80, kT: 1.0,
  aE: 0.9855, aM: 0.2254, aT: 0.5890, aR: 0.3959, flat_shell: 0.0929, speed_t: 162.886,
  c_l1: 0.0055, c_spec: 0.0146, lead_div: 4.0556, lead_cap: 32.0,
};
export const LEAD_SUPPORT = 0.35;

// ---------------------------------------------------------------- layout
// allele at offset o = (l*2+s)*9:
//   [o]   form (low 4 bits) | graft (high 4 bits, 15 = none)
//   [o+1] fusion depth   [o+2..3] seed u16 LE   [o+4..8] vec int8 x5
export type Genome = Uint8Array;
export const off = (l: number, s: number) => (l * 2 + s) * ALLELE_B;
export const form = (g: Genome, l: number, s: number) => g[off(l, s)] & 15;
export const graft = (g: Genome, l: number, s: number) => g[off(l, s)] >> 4;
export const depth = (g: Genome, l: number, s: number) => g[off(l, s) + 1];
export const aseed = (g: Genome, l: number, s: number) => g[off(l, s) + 2] | (g[off(l, s) + 3] << 8);
export const vecAt = (g: Genome, l: number, s: number, a: number) => (g[off(l, s) + 4 + a] << 24) >> 24;

export function writeAllele(g: Genome, l: number, s: number, f: number, gr: number, dp: number,
                            sd: number, vec: ArrayLike<number>) {
  const o = off(l, s);
  g[o] = (f & 15) | ((gr & 15) << 4);
  g[o + 1] = dp;
  g[o + 2] = sd & 255;
  g[o + 3] = (sd >> 8) & 255;
  for (let a = 0; a < NA; a++) g[o + 4 + a] = vec[a] & 255;
}

export const clampV = (x: number) => Math.max(-VMAX, Math.min(VMAX, Math.round(x)));

// THROWAWAY: negative control for core-purity (workshop #24). Reverted next commit.
export const PURITY_PROBE = Math.pow(1.5, 0.75);
