import type { Ring } from './ring.js';

/**
 * Rasterises rings with the even-odd rule, sampling at pixel centres, into a
 * `width x height` grid whose pixel (0,0) covers [originX, originX+1) x
 * [originY, originY+1) in ring coordinates. Holes are simply more rings.
 *
 * This is polygon -> mask, the other half of the conversion pair: it is what
 * turns a SAM polygon (or any vector annotation) into a `@osdlabel/mask`
 * snapshot, and what the PoC uses to score a polygon against the mask it was
 * traced from.
 */
export function fillRings(
  rings: readonly Ring[],
  width: number,
  height: number,
  originX = 0,
  originY = 0,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const xs: number[] = [];
  for (let row = 0; row < height; row++) {
    const y = originY + row + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Pixel col covers [originX+col, originX+col+1); its centre is inside when
      // xs[k] <= centre < xs[k+1].
      const c0 = Math.max(0, Math.ceil(xs[k]! - originX - 0.5));
      const c1 = Math.min(width, Math.ceil(xs[k + 1]! - originX - 0.5));
      if (c1 > c0) out.fill(1, row * width + c0, row * width + c1);
    }
  }
  return out;
}

/** Intersection-over-union of two equally sized binary grids. */
export function binaryIou(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new RangeError('grids differ in size');
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] !== 0;
    const y = b[i] !== 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union === 0 ? 1 : inter / union;
}
