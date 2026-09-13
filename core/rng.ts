// Seeded randomness for the core. Workshop issues #21, #23.
//
// sfc32, seeded by splitmix32. Integer-only, so identical in every engine.
// Every random draw in core/ comes from an Rng passed in by the caller: there
// is no global generator and no engine-provided randomness.

export type Rng = { a: number; b: number; c: number; d: number };

export function rng(seed: number): Rng {
  let s = seed >>> 0;
  const sm = () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const r = { a: sm(), b: sm(), c: sm(), d: sm() };
  for (let i = 0; i < 12; i++) u32(r);
  return r;
}

export function u32(r: Rng): number {
  const t = (((r.a + r.b) | 0) + r.d) | 0;
  r.d = (r.d + 1) | 0;
  r.a = r.b ^ (r.b >>> 9);
  r.b = (r.c + (r.c << 3)) | 0;
  r.c = (r.c << 21) | (r.c >>> 11);
  r.c = (r.c + t) | 0;
  return t >>> 0;
}

export const unit = (r: Rng) => u32(r) / 4294967296; // [0,1)
export const int = (r: Rng, n: number) => Math.floor(unit(r) * n);
export const uniform = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * unit(r);

// Irwin-Hall(4): an approximately normal draw with no transcendental functions.
// sd of a sum of 4 U(0,1) is sqrt(1/3); 1.7320508075688772 = sqrt(3) as a literal.
export const normal = (r: Rng, sd: number) =>
  (unit(r) + unit(r) + unit(r) + unit(r) - 2) * 1.7320508075688772 * sd;
