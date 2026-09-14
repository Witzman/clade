// Genome -> anatomy traits. Workshop #26.
//
// The renderer (anatomy.ts) reads a creature as four slots of floats: head,
// core, limbs, tail. The genome reads as twelve body systems, each expressing
// one form and a five-number investment. This file is the only place the two
// meet, and it decides whether the picture is an honest rendering of the
// genes. Its rules, and the reason for each, are written up on workshop #26.
//
// The rules in one paragraph:
//
//   * The SILHOUETTE is driven by the five expressed combat numbers -- the same
//     budget-scaled vector the fight reads. Bulk makes the body tall and deep
//     on thick legs, with a level back. Armour makes the body long, low, domed
//     and plated, and tucks the legs under it. Speed makes the legs long and
//     thin and the body shallow. Sharpness puts spikes on the outline. Reach
//     projects the head, the horn and the tail outward.
//   * FORMS decide topology and placement, never magnitude. The body form picks
//     the leg count; the weapon form decides whether sharpness shows as a horn,
//     a sting or an open jaw; the covering form decides whether it shows as
//     spines. A form nobody invested in stays vestigial: a "horn" allele with
//     no sharpness and no reach draws no horn.
//   * Where a form has no carrier big enough to see at 64 px, the magnitude
//     falls back to a carrier that is (spines along the back for sharpness, the
//     snout for reach). Sharpness that cannot be seen is a stat the player
//     cannot read, which is the thing this mapping exists to prevent.
//   * Colour carries NO combat information. The hue comes from two heritable
//     forms (skin x body heat), so a lineage keeps its colour and a shape is
//     never read off a hue.
//
// Pure and deterministic: no state, no randomness, and the genome is not
// written. render/ is exempt from the core's float ban; this file happens to
// need nothing but + - * / and min/max anyway.

import { express, form, ALLELE_B, NA, type Genome } from "../core/index.ts";
// The contract (field meanings, ranges, the size and seed rules) is declared
// by the consumer, render/anatomy.ts.
import type { AnatomyTraits } from "./anatomy.ts";

// body systems, in the core's SYSTEMS order
const SIZE = 0, SKIN = 1, BODY = 2, FRONT = 3, BACK = 4, HEAD = 5,
  WEAPON = 6, SPRAY = 7, FRAME = 8, COVER = 9, SENSES = 10, HEAT = 11;
// dimensions, in the core's order
const M = 0, R = 1, E = 2, T = 3, S = 4;

/** An expressed value at which a cue is fully drawn. The 95th percentile of a
 *  positive dimension in bred generation-20 populations is 94-147. */
export const V_SAT = 150;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampInt = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(x)));

// head form -> [length, depth, gape]: biting jaws, beak, heavy jaw, long snout, rasping tongue
const HEAD_BASE = [[0.35, 0.50, 0.45], [0.55, 0.30, 0.10], [0.25, 0.75, 0.35], [0.65, 0.30, 0.20], [0.20, 0.55, 0.15]];
// body form -> [leg count, splay, core length, core height, limb length, tail length, tail count]
// two legs, four legs, long body, spoke body, wings
const BODY_BASE = [
  [2, 0.30, 0.40, 0.00, 0.05, 0.00, 1],
  [4, 0.50, 0.50, 0.00, 0.00, 0.00, 1],
  [6, 0.90, 0.85, -0.12, -0.25, 0.30, 1],
  [8, 1.00, 0.40, 0.05, -0.10, 0.10, 5],
  [2, 0.30, 0.35, -0.05, 0.10, 0.10, 1],
];
// back-limb form -> [joints, foot, tail length]: running legs, flat feet, jumping legs, tail fin, gripping claws
const BACK_BASE = [[3, 0.50, 0.00], [2, 0.62, 0.00], [4, 0.45, 0.00], [2, 0.85, 0.20], [3, 0.15, 0.00]];
// senses form -> [eyes, eyeSize, stalks]: many-lens eyes, echo hearing, water sense, feelers, heat pits
const SENSE_BASE = [[3, 0.70, 0.00], [1, 0.25, 0.00], [2, 0.35, 0.00], [2, 0.45, 0.45], [1, 0.40, 0.00]];
// frame form -> [chitin, segments, height, hunch]: hard case, bony plates, inner bones, water-filled, gristle
const FRAME_BASE = [[0.10, 1, 0.00, 0.05], [0.05, 2, 0.00, 0.00], [0.00, 0, 0.00, 0.00], [-0.10, -1, 0.10, -0.10], [-0.05, 0, 0.00, 0.00]];
// skin form -> [chitin, fringe]: shell, scales, hide, fur, feathers
const SKIN_BASE = [[0.10, 0.00], [0.05, 0.00], [0.00, 0.00], [-0.05, 0.40], [-0.10, 0.55]];

const WEAPON_FANGS = 0, WEAPON_HORN = 1, WEAPON_STINGER = 2, WEAPON_TUSKS = 3, WEAPON_SPURS = 4;
const COVER_SPINES = 0, COVER_BRISTLES = 1, COVER_PLATES = 2, COVER_COLOUR = 3, COVER_HAIRS = 4;
const FRONT_PINCERS = 0, FRONT_GRABBING = 4;

export function traits(g: Genome): AnatomyTraits {
  const p = express(g);
  const f = (l: number) => form(g, l, p.expr[l]);
  // one expressed allele's investment in one dimension, deficiencies ignored
  const inv = (l: number, a: number) => Math.max(0, (g[(l * 2 + p.expr[l]) * ALLELE_B + 4 + a] << 24) >> 24);
  // each carrier's investment relative to the leading carrier: lead = 1
  const shares = (carriers: number[], a: number) => {
    const c = carriers.map(l => inv(l, a));
    const top = Math.max(...c);
    return c.map(x => (top > 0 ? x / top : 0));
  };

  // --- 1. how much of each dimension there is to draw ---------------------
  const u: number[] = [];
  for (let a = 0; a < NA; a++) u.push(Math.max(-1, Math.min(1, p.v[a] / V_SAT)));
  const lead = Math.max(0, ...u);
  // mild emphasis on the leading dimension, so a creature reads as its best
  // trait first. It never adds a cue that is absent: 0 stays 0.
  const t = u.map(x => (x > 0 && lead > 0 ? x * (0.65 + 0.35 * (x / lead)) : 0));
  const n = u.map(x => Math.max(0, -x)); // real deficiencies
  const [tM, tR, tE, tT, tS] = [t[M], t[R], t[E], t[T], t[S]];

  // --- 2. where sharpness and reach are carried ----------------------------
  const sh = shares([WEAPON, COVER, HEAD, FRONT, SKIN, SPRAY, SENSES], E);
  const eWeapon = tE * sh[0], eCover = tE * sh[1], eHead = tE * sh[2], eFront = tE * sh[3];
  const eDiffuse = tE * Math.max(sh[4], sh[5], sh[6]);
  const rs = shares([HEAD, WEAPON, BODY, FRAME, FRONT, BACK, SENSES], R);
  const rHead = tR * rs[0], rWeapon = tR * rs[1], rBody = tR * Math.max(rs[2], rs[3]);
  const rLimb = tR * Math.max(rs[4], rs[5]), rSense = tR * rs[6];

  const weapon = f(WEAPON), cover = f(COVER), front = f(FRONT);
  const [bCount, bSplay, bCoreLen, bCoreH, bLimbLen, bTailLen, bTailCount] = BODY_BASE[f(BODY)];
  const [kJoints, kFoot, kTailLen] = BACK_BASE[f(BACK)];
  const [hLen, hDepth, hGape] = HEAD_BASE[f(HEAD)];
  const [sEyes, sEyeSize, sStalks] = SENSE_BASE[f(SENSES)];
  const [frChitin, frSeg, frH, frHunch] = FRAME_BASE[f(FRAME)];
  const [skChitin, skFringe] = SKIN_BASE[f(SKIN)];

  // --- 3. head --------------------------------------------------------------
  let length = hLen + 0.50 * rHead + (weapon === WEAPON_FANGS ? 0.40 * rWeapon : 0) - 0.20 * n[R];
  length = Math.max(length, hLen + 0.45 * tR); // the snout always carries at least half the reach
  const horn = weapon === WEAPON_HORN || weapon === WEAPON_TUSKS
    ? (weapon === WEAPON_TUSKS ? 0.8 : 1) * eWeapon + 0.5 * rWeapon : 0;
  const head = {
    length: clamp01(length),
    depth: clamp01(hDepth + 0.35 * tM - 0.15 * tT - 0.15 * n[M]),
    gape: clamp01(hGape + (weapon === WEAPON_FANGS ? 0.60 * eWeapon : 0) + 0.45 * eHead),
    fringe: clamp01(skFringe + (cover === COVER_HAIRS ? 0.25 : 0)),
    horn: clamp01(horn),
    eyes: sEyes,
    eyeSize: clamp01(sEyeSize),
    stalks: clamp01(sStalks + 0.60 * rSense),
  };

  // --- 4. tail --------------------------------------------------------------
  const sting = weapon === WEAPON_STINGER ? clamp01(eWeapon + 0.3 * rWeapon) : 0;
  const tail = {
    length: clamp01(0.30 + bTailLen + kTailLen + 0.30 * rBody
      + (weapon === WEAPON_STINGER ? 0.35 * rWeapon : 0) + 0.30 * tT - 0.20 * n[R]),
    count: sting > 0.25 ? 1 : bTailCount, // a sting is only drawn on a single tail
    sting,
  };

  // --- 5. body ----------------------------------------------------------------
  let dorsal = eDiffuse * 0.7
    + (cover === COVER_SPINES ? eCover : cover === COVER_BRISTLES ? 0.8 * eCover
      : cover === COVER_PLATES ? 0.6 * eCover : 0)
    + (weapon === WEAPON_SPURS ? 0.5 * eWeapon : 0);
  // the fallback: sharpness must be visible on the outline, wherever it came from
  const spike = Math.max(head.horn, tail.sting, dorsal);
  if (spike < 0.85 * tE) dorsal += 0.85 * tE - spike;
  const core = {
    // Bulk and armour both thicken an animal, so they must part on the
    // OUTLINE, which survives 64 px, not on surface detail, which does not.
    // Bulk stands tall and level-backed (elephant). Armour spreads long and
    // low under a dome (tortoise). Plates alone were invisible at 64 px (v1).
    length: clamp01(bCoreLen + 0.35 * rBody + 0.25 * tM + 0.30 * tS - 0.25 * tT),
    height: clamp01(0.45 + bCoreH + frH + 0.45 * tM - 0.32 * tT - 0.25 * tS - 0.20 * n[M]),
    segments: clampInt(2 + 7 * tS + frSeg, 2, 9),
    // low base: plates draw only above 0.35, so only real armour draws them
    chitin: clamp01(0.15 + 0.85 * tS - 0.25 * n[S] + skChitin + frChitin),
    dorsal: clamp01(dorsal),
    hunch: clamp01(0.05 + 0.75 * tS - 0.35 * tT + frHunch),
  };

  // --- 6. limbs ---------------------------------------------------------------
  let joints = kJoints;
  if (tM > 0.6 && joints === 3) joints = 2; // a very heavy animal stands on pillars
  let foot = kFoot;
  if ((front === FRONT_PINCERS || front === FRONT_GRABBING) && eFront > 0.3) foot = Math.min(foot, 0.2);
  if (weapon === WEAPON_SPURS && eWeapon > 0.3) foot = Math.min(foot, 0.2);
  const limbs = {
    count: bCount,
    length: clamp01(0.50 + bLimbLen + 0.30 * rLimb + 0.45 * tT - 0.50 * tS - 0.15 * n[T]),
    joints,
    thickness: clamp01(0.35 + 0.55 * tM - 0.40 * tT - 0.15 * n[M] + 0.10 * n[T]),
    foot: clamp01(foot),
    splay: clamp01(bSplay),
  };

  // --- 7. identity: size, colour, pattern ---------------------------------
  let spray = 0;
  for (let a = 0; a < NA; a++) spray += Math.abs((g[(SPRAY * 2 + p.expr[SPRAY]) * ALLELE_B + 4 + a] << 24) >> 24);
  const skinOff = (SKIN * 2 + p.expr[SKIN]) * ALLELE_B;
  return {
    head, core, limbs, tail,
    size: p.tier / 4,
    hue: (((f(SKIN) * 5 + f(HEAT)) % 6) + 0.5) / 6,
    pattern: clamp01(spray / V_SAT + (cover === COVER_COLOUR ? 0.4 : 0)),
    seed: g[skinOff + 2] | (g[skinOff + 3] << 8),
  };
}

// SIZE is read through express().tier; named here so every system's use is visible.
void SIZE;
