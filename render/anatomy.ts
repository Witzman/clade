// Creature geometry built from trait NUMBERS only — no animal labels.
//
// A transcription of the #22 experiment's `anatomy.build()`. Every constant is
// the Python's; a change here is a change to how every creature looks, and the
// port was checked against the Python side by side (workshop issue #27).
//
// Nothing in this file knows what a lion is. It takes a vector of floats and
// returns polygons with a draw order, which is what lets it draw a creature
// nobody authored.
//
// Everything faces RIGHT. Canvas is S x S, ground line at 0.90 S.

/**
 * What the renderer reads. Produced from a genome by `render/traits.ts`
 * (workshop issue #26); declared here, by the consumer, so there is one copy.
 *
 * Floats are expected in [0,1]. Fields marked integer must be integers.
 */
export interface AnatomyTraits {
  head: {
    length: number; // 0 blunt skull .. 1 long beak/snout
    depth: number; // 0 shallow .. 1 deep jaw / bulbous
    gape: number; // 0 closed .. 1 wide maw
    fringe: number; // mane / frill (> 0.06 draws)
    horn: number; // horn / mandible (> 0.08 draws, > 0.55 a pair)
    eyes: number; // integer 1..4, ranked up the brow
    eyeSize: number;
    stalks: number; // > 0.3 draws stalks
  };
  core: {
    length: number;
    height: number;
    segments: number; // integer 2..9 (plates drawn only if chitin > 0.35)
    chitin: number; // 0 soft hide .. 1 hard shell; also picks the material
    dorsal: number; // spine ridge (> 0.08 draws)
    hunch: number;
  };
  limbs: {
    count: number; // integer, even, 2..8 — drawn as count/2 pairs
    length: number;
    joints: number; // integer 2..4: simple, digitigrade, insectile
    thickness: number;
    foot: number; // 0 talon .. 0.5 paw .. 1 tentacle pad
    splay: number;
  };
  tail: {
    length: number;
    count: number; // integer 1..6; > 1 is a tentacle cluster
    sting: number; // > 0.25 draws, single tail only
  };
  /** Body-size class 0..1 (tiny .. huge). Applied by `scaled()`, never by `build()`. */
  size: number;
  hue: number; // [0,1) -> palette family
  pattern: number; // read by the silhouette surface
  /**
   * uint16. Procedural jitter ONLY. Breeding re-rolls it at every birth, so a
   * child carrying its parent's allele gets a different seed: nothing a player
   * should recognise across a lineage may key on it.
   */
  seed: number;
}

export type PartKind =
  | 'core' | 'plate' | 'head' | 'jaw' | 'limb' | 'foot' | 'tail' | 'fringe' | 'horn';

export interface Part {
  /** Flat [x0, y0, x1, y1, ...] in canvas units. */
  pts: number[];
  /** Draw order, low first. */
  layer: number;
  kind: PartKind;
  /** 1.0 lit, < 1 behind. */
  shade: number;
  /** false for the segment-plate strokes. */
  closed: boolean;
}

export interface Anatomy {
  parts: Part[];
  /** [x, y, r] per eye. */
  eyes: [number, number, number][];
  ground: number;
  core: { cx: number; cy: number; w: number; h: number };
  head: { x: number; y: number; r: number };
}

const TAU = Math.PI * 2;
type Pt = [number, number];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const copysign = (m: number, s: number) => (s < 0 || Object.is(s, -0) ? -Math.abs(m) : Math.abs(m));

function superellipse(cx: number, cy: number, a: number, b: number, n = 2.4, steps = 72, rot = 0): Pt[] {
  const pts: Pt[] = [];
  const e = 2.0 / n;
  for (let i = 0; i < steps; i++) {
    const t = (TAU * i) / steps;
    const ct = Math.cos(t), st = Math.sin(t);
    let x = a * copysign(Math.abs(ct) ** e, ct);
    let y = b * copysign(Math.abs(st) ** e, st);
    if (rot) {
      const xr = x * Math.cos(rot) - y * Math.sin(rot);
      y = x * Math.sin(rot) + y * Math.cos(rot);
      x = xr;
    }
    pts.push([cx + x, cy + y]);
  }
  return pts;
}

/** Polygon around a polyline whose radius goes r0 -> r1. */
function taper(path: Pt[], r0: number, r1: number, cap = true): Pt[] {
  const left: Pt[] = [], right: Pt[] = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const [x, y] = path[i];
    const t = i / Math.max(1, n - 1);
    const r = r0 + (r1 - r0) * t;
    let dx: number, dy: number;
    if (i === 0) { dx = path[1][0] - x; dy = path[1][1] - y; }
    else if (i === n - 1) { dx = x - path[n - 2][0]; dy = y - path[n - 2][1]; }
    else { dx = path[i + 1][0] - path[i - 1][0]; dy = path[i + 1][1] - path[i - 1][1]; }
    const ln = Math.hypot(dx, dy) || 1.0;
    const nx = (-dy / ln) * r, ny = (dx / ln) * r;
    left.push([x + nx, y + ny]);
    right.push([x - nx, y - ny]);
  }
  if (cap) {
    const [ex, ey] = path[n - 1];
    const dx = path[n - 1][0] - path[n - 2][0], dy = path[n - 1][1] - path[n - 2][1];
    const ln = Math.hypot(dx, dy) || 1.0;
    left.push([ex + (dx / ln) * r1 * 0.9, ey + (dy / ln) * r1 * 0.9]);
  }
  return left.concat(right.reverse());
}

/** A gently curving polyline: the spine of a tail, a horn, a tentacle. */
function arcPath(x: number, y: number, angle: number, length: number, curve: number, steps = 10): Pt[] {
  const pts: Pt[] = [[x, y]];
  let a = angle;
  for (let i = 0; i < steps; i++) {
    a += curve / steps;
    x += (Math.cos(a) * length) / steps;
    y += (Math.sin(a) * length) / steps;
    pts.push([x, y]);
  }
  return pts;
}

const flat = (pts: Pt[]) => {
  const out = new Array<number>(pts.length * 2);
  for (let i = 0; i < pts.length; i++) { out[i * 2] = pts[i][0]; out[i * 2 + 1] = pts[i][1]; }
  return out;
};

/**
 * Limb half-width, as a fraction of S, at `limbs.thickness` 0 and 1.
 *
 * The Python had 0.010 .. 0.062. Widened for workshop #32: at 64 px a thin leg
 * is mostly the ink ring and renders as a near-black bar, so a 2 px black bar
 * and a 6 px grey column read as the same weight and leg thickness stopped
 * separating "quick" from "heavy". A pillar has to be a pillar.
 */
/**
 * Leg length, as a fraction of S, at `limbs.length` 0 and 1. The Python had
 * 0.100 .. 0.440. Widened for workshop #32 with the same reasoning as the
 * radii: ground clearance is the outline cue that separates a sprinter from a
 * heavy animal, and at 64 px the old range left them a few pixels apart.
 */
export const LEG_L0 = 0.06;
export const LEG_L1 = 0.46;

export const LIMB_R0 = 0.008;
export const LIMB_R1 = 0.078;

export function build(c: AnatomyTraits, S: number): Anatomy {
  const H = c.head, C = c.core, L = c.limbs, T = c.tail;
  const parts: Part[] = [];
  const add = (p: { pts: Pt[]; layer: number; kind: PartKind; shade?: number; closed?: boolean }) =>
    parts.push({ pts: flat(p.pts), layer: p.layer, kind: p.kind, shade: p.shade ?? 1.0, closed: p.closed ?? true });

  const ground = 0.9 * S;
  const legLen = (LEG_L0 + LEG_L1 * L.length) * S;
  const coreW = (0.26 + 0.26 * C.length) * S;
  const coreH = (0.13 + 0.2 * C.height) * S;
  const cx = 0.46 * S;
  const cy = ground - legLen - coreH * 0.55;

  // core: harder chitin -> boxier superellipse, hunch lifts the withers
  const nExp = lerp(2.0, 3.6, C.chitin);
  let core = superellipse(cx, cy, coreW / 2, coreH / 2, nExp, 96);
  if (C.hunch > 0.02) {
    const lift = C.hunch * coreH * 0.55;
    core = core.map(([x, y]): Pt => [
      x,
      y < cy ? y - lift * Math.exp(-(((x - (cx - coreW * 0.12)) / (coreW * 0.34)) ** 2)) : y,
    ]);
  }
  add({ pts: core, layer: 30, kind: 'core' });

  // top/bottom of the (un-hunched) core at x
  const edgeK = (x: number) => Math.sqrt(Math.max(0.0, 1 - ((x - cx) / (coreW / 2)) ** 2)) ** (2.0 / nExp);

  // dorsal ridge: a row of spines along the back
  if (C.dorsal > 0.08) {
    const nspine = 3 + Math.trunc(C.dorsal * 9);
    for (let i = 0; i < nspine; i++) {
      const t = i / Math.max(1, nspine - 1);
      const x = cx - coreW * 0.4 + coreW * 0.8 * t;
      const y = cy - (coreH / 2) * edgeK(x);
      const hgt = C.dorsal * coreH * (0.3 + 0.45 * Math.sin(Math.PI * t));
      add({
        pts: [[x - coreW * 0.035, y + 2], [x, y - hgt], [x + coreW * 0.035, y + 2]],
        layer: 29, kind: 'horn', shade: 0.9,
      });
    }
  }

  // segment plates: the read for "armoured"
  if (C.chitin > 0.35 && C.segments >= 2) {
    for (let i = 1; i < C.segments; i++) {
      const t = i / C.segments;
      const x = cx - coreW * 0.46 + coreW * 0.92 * t;
      const k = edgeK(x);
      const yt = cy - (coreH / 2) * k;
      const yb = cy + (coreH / 2) * k;
      add({ pts: [[x, yt], [x + coreW * 0.02, cy], [x, yb]], layer: 31, kind: 'plate', closed: false });
    }
  }

  // limbs
  const pairs = Math.max(1, Math.trunc(L.count / 2));
  const spread = coreW * (0.3 + 0.58 * L.splay);
  const thick = (LIMB_R0 + LIMB_R1 * L.thickness) * S;

  const oneLimb = (hx: number, hy: number, front: boolean, t: number) => {
    const seg = Math.max(2, L.joints);
    // insectile joints zig-zag hard; mammal joints barely bend
    const zig = lerp(0.15, 1.0, (L.joints - 2) / 2.0);
    let a = Math.PI / 2 - (0.22 + 0.3 * t - 0.26) * zig;
    const path: Pt[] = [[hx, hy]];
    let x = hx, y = hy;
    for (let j = 0; j < seg; j++) {
      const step = (legLen / seg) * (j ? 1.0 : 1.15);
      a += (j % 2 === 0 ? 0.55 : -0.75) * zig;
      a = Math.max(Math.PI * 0.16, Math.min(Math.PI * 0.84, a));
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      path.push([x, y]);
    }
    const sh = front ? 1.0 : 0.66;
    add({ pts: taper(path, thick, thick * 0.45), layer: front ? 32 : 10, kind: 'limb', shade: sh });
    // foot: talon -> paw -> pad, continuous in L.foot
    const [fx, fy] = path[path.length - 1];
    const fl = front ? 33 : 11;
    if (L.foot < 0.34) {
      for (const k of [-1, 0, 1]) {
        add({
          pts: taper([[fx, fy], [fx + coreW * 0.055 * (k + 0.4), fy + thick * 0.9]], thick * 0.42, thick * 0.16),
          layer: fl, kind: 'foot', shade: sh,
        });
      }
    } else if (L.foot < 0.72) {
      add({ pts: superellipse(fx + thick * 0.4, fy, thick * 1.5, thick * 0.75, 3.0, 24), layer: fl, kind: 'foot', shade: sh });
    } else {
      add({ pts: taper(arcPath(fx, fy, -0.2, thick * 4.0, 2.2, 8), thick * 0.8, thick * 0.2), layer: fl, kind: 'foot', shade: sh });
    }
  };

  for (const front of [false, true]) {
    for (let i = 0; i < pairs; i++) {
      const t = pairs === 1 ? 0.0 : i / (pairs - 1);
      const hx = cx - spread / 2 + spread * t + (front ? 0 : coreW * 0.06);
      const hy = cy + (coreH / 2) * edgeK(hx) - coreH * 0.06;
      oneLimb(hx, hy, front, t);
    }
  }

  // tail / appendage cluster
  const tx = cx - coreW * 0.47;
  const ty = cy + coreH * 0.05;
  const tl = (0.06 + 0.3 * T.length) * S;
  if (T.count <= 1) {
    const sp = arcPath(tx, ty, Math.PI * 0.92, tl, -1.3 * (1 - T.sting), 12);
    add({ pts: taper(sp, thick * 0.85, thick * 0.22), layer: 9, kind: 'tail', shade: 0.8 });
    if (T.sting > 0.25) {
      const [ex, ey] = sp[sp.length - 1];
      add({
        pts: taper(arcPath(ex, ey, Math.PI * 1.35, tl * 0.3, 0.5, 5), thick * 0.5, thick * 0.05),
        layer: 9, kind: 'horn', shade: 0.8,
      });
    }
  } else {
    for (let i = 0; i < T.count; i++) {
      const u = i / Math.max(1, T.count - 1);
      add({
        pts: taper(
          arcPath(tx, ty - coreH * 0.3 + coreH * 0.55 * u, Math.PI * (0.8 + 0.3 * u), tl * (0.7 + 0.5 * u), -2.4 + 1.6 * u, 12),
          thick * 0.7, thick * 0.12,
        ),
        layer: 8 + (i % 2), kind: 'tail', shade: 0.72 + 0.18 * u,
      });
    }
  }

  // head
  const hx = cx + coreW * 0.4;
  const hy = cy - coreH * (0.18 + 0.3 * C.hunch);
  const cranR = (0.045 + 0.055 * H.depth) * S;
  // skulls stay rounded even on armoured bodies: a boxy head reads as a crate
  add({ pts: superellipse(hx, hy, cranR * 1.05, cranR, lerp(2.0, 2.4, C.chitin), 48), layer: 40, kind: 'head' });

  // neck, so the head is attached rather than floating
  add({ pts: taper([[cx + coreW * 0.24, cy - coreH * 0.18], [hx, hy]], coreH * 0.26, cranR * 0.78), layer: 39, kind: 'core' });

  // jaws / beak: length stretches them, gape opens them
  const snout = (0.05 + 0.19 * H.length) * S;
  const gap = H.gape * 0.45;
  add({
    pts: taper(arcPath(hx + cranR * 0.5, hy - cranR * 0.12, -gap * 0.5, snout, gap * 0.5, 6),
      cranR * (0.62 - 0.28 * H.length), cranR * (0.08 + 0.16 * H.depth)),
    layer: 41, kind: 'jaw',
  });
  add({
    pts: taper(arcPath(hx + cranR * 0.5, hy + cranR * 0.18, gap, snout * (0.82 + 0.18 * H.gape), -gap * 0.4, 6),
      cranR * (0.42 - 0.18 * H.length), cranR * (0.06 + 0.11 * H.depth)),
    layer: 41, kind: 'jaw', shade: 0.88,
  });

  // fringe: a MASS with a ragged edge, then tufts of uneven length on top
  if (H.fringe > 0.06) {
    const reach = cranR * (0.55 + 1.05 * H.fringe);
    const lobe: Pt[] = [];
    for (let i = 0; i < 40; i++) {
      const a = Math.PI * (0.3 + (1.42 * i) / 39);
      const r = cranR * 0.8 + reach * (0.55 + 0.45 * Math.sin(a * 2.1 + 1.0));
      lobe.push([hx + Math.cos(a) * r, hy + Math.sin(a) * r]);
    }
    lobe.push([hx + cranR * 0.2, hy + cranR * 0.4]);
    add({ pts: lobe, layer: 37, kind: 'fringe', shade: 0.92 });
    const nf = 14 + Math.trunc(H.fringe * 22);
    for (let i = 0; i < nf; i++) {
      const a = Math.PI * (0.3 + (1.42 * i) / (nf - 1));
      const r0 = cranR * 0.8 + reach * (0.4 + 0.35 * Math.sin(a * 2.1 + 1.0));
      const ln = reach * (0.14 + 0.2 * Math.abs(Math.sin(i * 2.4)));
      add({
        pts: taper(arcPath(hx + Math.cos(a) * r0, hy + Math.sin(a) * r0, a + 0.25, ln, -0.5, 5), cranR * 0.2, cranR * 0.03),
        layer: 38, kind: 'fringe', shade: 0.86,
      });
    }
  }

  // horn / mandible off the brow
  if (H.horn > 0.08) {
    for (const s of H.horn > 0.55 ? [1, -1] : [1]) {
      add({
        pts: taper(arcPath(hx + cranR * 0.35, hy - cranR * 0.72 * s, -0.9 * s, H.horn * 0.16 * S, 1.1 * s, 8), cranR * 0.26, cranR * 0.03),
        layer: 42, kind: 'horn',
      });
    }
  }

  // eyes: ONE per rank in a lateral view, ranked up the brow, never across
  const eyes: [number, number, number][] = [];
  const er = cranR * (0.1 + 0.15 * H.eyeSize);
  for (let i = 0; i < Math.max(1, H.eyes); i++) {
    const u = H.eyes === 1 ? 0.0 : i / (H.eyes - 1);
    const a = -0.55 - 0.75 * u;
    let ex = hx + Math.cos(a) * cranR * 0.5;
    let ey = hy + Math.sin(a) * cranR * 0.5;
    if (H.stalks > 0.3) {
      const sl = cranR * H.stalks * 1.5;
      const sx = ex + Math.cos(a) * sl, sy = ey + Math.sin(a) * sl;
      add({ pts: taper([[ex, ey], [sx, sy]], er * 0.45, er * 0.3), layer: 43, kind: 'limb' });
      ex = sx; ey = sy;
    }
    eyes.push([ex, ey, er]);
  }

  parts.sort((p, q) => p.layer - q.layer); // stable, as Python's sorted()
  return { parts, eyes, ground, core: { cx, cy, w: coreW, h: coreH }, head: { x: hx, y: hy, r: cranR } };
}

/** Draw scale for a body-size class: 0.70 (tiny) .. 1.00 (huge). */
export const sizeScale = (size: number) => 0.7 + 0.3 * Math.min(Math.max(size, 0), 1);

/**
 * `build()` then the body-size scale, applied about (0.46 S, ground 0.90 S) so
 * the feet stay on the ground line. Kept out of `build()` so that function
 * stays a line-for-line port of the Python. Scales points and radii, not line
 * widths: a small creature keeps a contour as legible as a large one's.
 */
export function scaled(c: AnatomyTraits, S: number): Anatomy {
  const geo = build(c, S);
  const s = sizeScale(c.size);
  if (s === 1) return geo;
  const ox = 0.46 * S, oy = geo.ground;
  const X = (x: number) => ox + (x - ox) * s;
  const Y = (y: number) => oy + (y - oy) * s;
  for (const p of geo.parts) {
    for (let i = 0; i < p.pts.length; i += 2) { p.pts[i] = X(p.pts[i]); p.pts[i + 1] = Y(p.pts[i + 1]); }
  }
  return {
    parts: geo.parts,
    eyes: geo.eyes.map(([x, y, r]) => [X(x), Y(y), r * s]),
    ground: geo.ground,
    core: { cx: X(geo.core.cx), cy: Y(geo.core.cy), w: geo.core.w * s, h: geo.core.h * s },
    head: { x: X(geo.head.x), y: Y(geo.head.y), r: geo.head.r * s },
  };
}
