import type { GrayscaleRaster, StoredPixelArray } from './raster.js';
import { allocateLike } from './raster.js';

/**
 * Halve a raster with a 2x2 box filter, keeping full stored precision (no
 * 8-bit round trip: the whole point of a high-bit-depth pyramid). Odd edges
 * average the pixels that exist. Output is `ceil(w/2) x ceil(h/2)`.
 */
export function downsample2x(src: GrayscaleRaster): GrayscaleRaster {
  const w = Math.max(1, Math.ceil(src.width / 2));
  const h = Math.max(1, Math.ceil(src.height / 2));
  const out = allocateLike(src.data, w * h);
  const s = src.data;
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < h; y++) {
    const y0 = y * 2;
    const y1 = Math.min(y0 + 1, sh - 1);
    for (let x = 0; x < w; x++) {
      const x0 = x * 2;
      const x1 = Math.min(x0 + 1, sw - 1);
      const sum = s[y0 * sw + x0]! + s[y0 * sw + x1]! + s[y1 * sw + x0]! + s[y1 * sw + x1]!;
      out[y * w + x] = Math.round(sum / 4);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Build every level down to 1x1, finest last, the order OpenSeadragon numbers
 * them in (level `maxLevel` is full resolution, level 0 is 1x1).
 */
export function buildPyramid(full: GrayscaleRaster): GrayscaleRaster[] {
  const levels: GrayscaleRaster[] = [full];
  let cur = full;
  while (cur.width > 1 || cur.height > 1) {
    cur = downsample2x(cur);
    levels.push(cur);
  }
  return levels.reverse();
}

/** Copy a rectangle out of a raster (clipped to its bounds). */
export function extractRegion(
  src: GrayscaleRaster,
  x: number,
  y: number,
  width: number,
  height: number,
): GrayscaleRaster {
  const x0 = Math.max(0, Math.min(src.width, x));
  const y0 = Math.max(0, Math.min(src.height, y));
  const w = Math.max(0, Math.min(src.width - x0, width));
  const h = Math.max(0, Math.min(src.height - y0, height));
  const out: StoredPixelArray = allocateLike(src.data, w * h);
  for (let row = 0; row < h; row++) {
    const start = (y0 + row) * src.width + x0;
    out.set(src.data.subarray(start, start + w), row * w);
  }
  return { width: w, height: h, data: out };
}
