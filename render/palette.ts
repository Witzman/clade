// One palette, imported by every renderer. Colour drift is what makes
// generated art look cheap, so the values live here and nowhere else.
//
// Port of the #22 experiment's palette. A creature is read by its silhouette
// against the backdrop, then by two or three value steps inside it; more than
// three values inside one body is mud at game size.

export type RGB = readonly [number, number, number];

/** Backdrops a creature must survive against. */
export const PAPER: RGB = [232, 226, 211];
export const SLATE: RGB = [38, 42, 48];

export const INK: RGB = [26, 22, 20];
export const INK_SOFT: RGB = [74, 64, 58];

/** (shadow, base, light). Three steps, no more. */
export type Family = readonly [RGB, RGB, RGB];

export const HUE_FAMILIES: readonly Family[] = [
  [[122, 82, 38], [186, 138, 62], [226, 190, 120]], // ochre
  [[110, 50, 34], [168, 84, 52], [214, 143, 104]], // rust
  [[62, 84, 48], [110, 138, 72], [170, 190, 122]], // moss
  [[38, 82, 86], [68, 132, 134], [134, 186, 184]], // teal
  [[74, 56, 96], [117, 92, 146], [178, 156, 202]], // violet
  [[104, 96, 84], [158, 150, 134], [214, 208, 190]], // bone
];

export const ACCENT: RGB = [222, 86, 52];

/**
 * A continuous colour gene in [0,1) -> one discrete family. Discrete on
 * purpose: a continuous hue drifts a bred population toward one muddy average.
 */
export function familyFor(gene: number): Family {
  const n = HUE_FAMILIES.length;
  const i = ((Math.trunc(gene * n) % n) + n) % n;
  return HUE_FAMILIES[i];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function css(c: RGB, alpha = 1): string {
  return alpha === 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
