// The small representation: the whole creature as ONE filled Path2D, for
// anything drawn at 48 px or less (map, roster strip, combat shadow).
//
// At that size a creature IS its silhouette, so every closed part is welded
// into one path and filled once. Port of the #22 experiment's silhouette
// renderer, reduced to what survives at 48 px: the fill (lit back, dark belly),
// one hard contour, and the eye dot — "a silhouette with no eye reads as a
// rock". The rim light and the procedural surface are sub-pixel at this size
// and are left out; that is a deliberate simplification, not an omission.
//
// Cheap enough to rebuild per draw, but cache it anyway.

import { scaled, type AnatomyTraits } from './anatomy.ts';
import { ACCENT, INK, css, familyFor, mix, type RGB } from './palette.ts';

export interface Silhouette {
  size: number;
  path: Path2D;
  eyes: [number, number, number][];
  top: number;
  bottom: number;
  base: RGB;
  dark: RGB;
}

function signedArea(pts: number[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
}

/**
 * Build the silhouette at `size` CSS px. Every subpath is wound the same way,
 * so the nonzero fill is the union of the parts: two overlapping polygons of
 * opposite winding would otherwise cancel into a hole.
 */
export function silhouette(traits: AnatomyTraits, size: number): Silhouette {
  const geo = scaled(traits, size);
  const path = new Path2D();
  let top = Infinity, bottom = -Infinity;
  for (const p of geo.parts) {
    if (!p.closed) continue; // segment plates lie inside the core
    const pts = p.pts;
    const n = pts.length;
    const rev = signedArea(pts) < 0;
    for (let i = 0; i < n; i += 2) {
      const k = rev ? n - 2 - i : i;
      const x = pts[k], y = pts[k + 1];
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    path.closePath();
  }
  const [shadow, base] = familyFor(traits.hue);
  return {
    size,
    path,
    eyes: geo.eyes.map(([x, y, r]) => [x, y, Math.max(r, size * 0.006 * 3)]),
    top,
    bottom,
    base,
    dark: mix(shadow, INK, 0.45),
  };
}

/** Draw at (x, y) in the context's current units. */
export function drawSilhouette(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  s: Silhouette,
  x: number,
  y: number,
): void {
  g.save();
  g.translate(x, y);
  // contour: a wide stroke under the fill leaves only the outer ring visible
  g.lineJoin = 'round';
  g.lineWidth = Math.max(1.25, s.size * 0.028);
  g.strokeStyle = css(INK);
  g.stroke(s.path);
  // body: lit back, dark belly
  const grad = g.createLinearGradient(0, s.top, 0, s.bottom);
  grad.addColorStop(0, css(s.base));
  grad.addColorStop(1, css(s.dark));
  g.fillStyle = grad;
  g.fill(s.path);
  for (const [ex, ey, er] of s.eyes) {
    g.fillStyle = css(ACCENT);
    g.beginPath();
    g.arc(ex, ey, er * 1.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = css(INK);
    g.beginPath();
    g.arc(ex, ey, er * 0.55, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}
