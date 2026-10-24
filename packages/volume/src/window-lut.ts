/** Offset that maps an int16 voxel value to a LUT index. */
export const LUT_OFFSET = 32768;

/**
 * A 65536-entry lookup table from int16 value to an opaque grey RGBA pixel
 * (little-endian `0xAABBGGRR`, i.e. what a `Uint32Array` view over
 * `ImageData.data` expects), for a DICOM-style linear window.
 */
export function buildWindowLut(center: number, width: number): Uint32Array {
  const lut = new Uint32Array(65536);
  const lo = center - width / 2;
  for (let i = 0; i < 65536; i++) {
    const v = i - LUT_OFFSET;
    let g = Math.round(((v - lo) / width) * 255);
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    lut[i] = (0xff000000 | (g << 16) | (g << 8) | g) >>> 0;
  }
  return lut;
}

/** Window `src` into `dst` (same length) through `lut`. */
export function applyWindowLut(src: Int16Array, lut: Uint32Array, dst: Uint32Array): void {
  const n = src.length;
  for (let i = 0; i < n; i++) dst[i] = lut[src[i]! + LUT_OFFSET]!;
}
