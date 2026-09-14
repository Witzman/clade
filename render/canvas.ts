// Scratch canvases for baking. OffscreenCanvas where the browser has a 2D
// context for it (Safari only from 16.4), a detached <canvas> otherwise.

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

let offscreenOk: boolean | null = null;

export function makeCanvas(w: number, h: number): AnyCanvas {
  if (offscreenOk !== false && typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    if (offscreenOk === null) offscreenOk = c.getContext('2d') !== null;
    if (offscreenOk) return new OffscreenCanvas(w, h);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: AnyCanvas, willReadFrequently = false): Ctx2D {
  const g = c.getContext('2d', { willReadFrequently }) as Ctx2D | null;
  if (!g) throw new Error('2D canvas context unavailable');
  return g;
}

/** Append a flat [x0,y0,x1,y1,...] polyline to the current path, scaled by k. */
export function trace(g: Ctx2D | Path2D, pts: number[], k: number, close: boolean): void {
  g.moveTo(pts[0] * k, pts[1] * k);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] * k, pts[i + 1] * k);
  if (close) g.closePath();
}
