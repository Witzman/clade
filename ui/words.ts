// Wording every variant shares, word for word. DOM-free, so the node tests can
// assert it. Workshop issue #61 (variant directions §1.4).
//
// The counters panel appears on every how-to-play screen with identical text,
// so it is not a thing the variants are compared on. Change it here or nowhere.

export const COUNTERS_TITLE = "What beats what.";

export const COUNTERS_TEXT =
  "Armour stops sharp weapons and softens every blow. " +
  "A heavy animal cannot land a blow on a quick one. " +
  "Quick, light attacks do not trouble a heavy animal. " +
  "Sharp parts also cut whoever attacks them. " +
  "The longer reach strikes first.";

/** The five dimensions, in core's order (BULK, REACH, SHARP, SPEED, ARMOUR), as a sentence names them. */
export const DIMENSIONS = ["bulk", "reach", "sharpness", "speed", "armour"] as const;

/** A card's tag: where a creature came from. */
export type Tag = "founder" | "young" | "captured";
export const TAGS: readonly Tag[] = ["founder", "young", "captured"];
