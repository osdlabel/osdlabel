import type { StoredPixelArray, StoredRange } from './raster.js';
import type { ModalityRescale, VoiWindow } from './voi.js';
import { applyRescale, applyVoi } from './voi.js';

/** Everything that decides how a stored value is displayed. */
export interface DisplayTransform {
  readonly rescale: ModalityRescale;
  readonly window: VoiWindow;
  /** MONOCHROME1, or a user "invert": 0 displays white. */
  readonly invert: boolean;
}

/**
 * A precomputed stored-value -> display lookup table covering `range`.
 *
 * Indexing is `lut[stored - range.min]`. The table holds the display value both
 * as a grey byte and as a packed opaque RGBA word, so the hot loop can write a
 * whole pixel with one 32-bit store.
 */
export interface VoiLut {
  readonly range: StoredRange;
  readonly gray: Uint8Array;
  readonly rgba32: Uint32Array;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Pack an opaque grey into the platform's native RGBA word order. */
export function packGray(g: number): number {
  return LITTLE_ENDIAN
    ? ((0xff << 24) | (g << 16) | (g << 8) | g) >>> 0
    : ((g << 24) | (g << 16) | (g << 8) | 0xff) >>> 0;
}

/** The 8-bit display value for one stored value. */
export function displayValue(stored: number, t: DisplayTransform): number {
  const y = Math.round(applyVoi(applyRescale(stored, t.rescale), t.window, 0, 255));
  return t.invert ? 255 - y : y;
}

/**
 * Build the LUT for `range` under `t`. Cost is O(range size): 4,001 entries
 * for a -1000..3000 HU CT, 65,536 for a full 16-bit mammogram.
 */
export function buildVoiLut(range: StoredRange, t: DisplayTransform): VoiLut {
  const size = range.max - range.min + 1;
  const gray = new Uint8Array(size);
  const rgba32 = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    const g = displayValue(range.min + i, t);
    gray[i] = g;
    rgba32[i] = packGray(g);
  }
  return { range, gray, rgba32 };
}

/**
 * Write `src[start..end)` through the LUT into `dst` as opaque grey RGBA, one
 * 32-bit store per pixel. Values outside the LUT's range are clamped to it.
 *
 * `dst` is a `Uint32Array` view over the RGBA bytes (e.g. over an
 * `ImageData.data.buffer`); `dst[i]` receives pixel `i`.
 */
export function applyVoiLutRgba32(
  src: StoredPixelArray,
  lut: VoiLut,
  dst: Uint32Array,
  start = 0,
  end = src.length,
): void {
  const table = lut.rgba32;
  const min = lut.range.min;
  const last = table.length - 1;
  for (let i = start; i < end; i++) {
    let k = src[i]! - min;
    if (k < 0) k = 0;
    else if (k > last) k = last;
    dst[i] = table[k]!;
  }
}

/**
 * The same as {@link applyVoiLutRgba32} but writing four bytes per pixel. Kept
 * only so the benchmark can show what the packed store is worth.
 */
export function applyVoiLutBytes(
  src: StoredPixelArray,
  lut: VoiLut,
  dst: Uint8ClampedArray,
  start = 0,
  end = src.length,
): void {
  const table = lut.gray;
  const min = lut.range.min;
  const last = table.length - 1;
  for (let i = start; i < end; i++) {
    let k = src[i]! - min;
    if (k < 0) k = 0;
    else if (k > last) k = last;
    const g = table[k]!;
    const o = i << 2;
    dst[o] = g;
    dst[o + 1] = g;
    dst[o + 2] = g;
    dst[o + 3] = 255;
  }
}

/**
 * No table: evaluate the VOI function per pixel (`LINEAR` only, inlined). The
 * benchmark's baseline for what the LUT saves.
 */
export function applyVoiDirectRgba32(
  src: StoredPixelArray,
  t: DisplayTransform,
  dst: Uint32Array,
  start = 0,
  end = src.length,
): void {
  const { slope, intercept } = t.rescale;
  const w = Math.max(1, t.window.width);
  const c = t.window.center;
  const lo = c - 0.5 - (w - 1) / 2;
  const hi = c - 0.5 + (w - 1) / 2;
  const inv = t.invert;
  for (let i = start; i < end; i++) {
    const x = src[i]! * slope + intercept;
    let y: number;
    if (x <= lo) y = 0;
    else if (x > hi) y = 255;
    else y = Math.round(((x - (c - 0.5)) / (w - 1) + 0.5) * 255);
    if (inv) y = 255 - y;
    dst[i] = packGray(y);
  }
}
