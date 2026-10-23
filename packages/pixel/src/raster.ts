/**
 * Stored-value arrays a grayscale raster may hold. DICOM `BitsAllocated` 8 or
 * 16 with `PixelRepresentation` 0 (unsigned) or 1 (signed, CT).
 */
export type StoredPixelArray = Int16Array | Uint16Array | Uint8Array;

/** The element type of a {@link StoredPixelArray}, as a tag. */
export type StoredPixelType = 'int16' | 'uint16' | 'uint8';

/**
 * A single-channel raster of *stored* values: what the scanner wrote, before
 * any modality rescale or VOI. Row-major, no padding.
 */
export interface GrayscaleRaster {
  readonly width: number;
  readonly height: number;
  readonly data: StoredPixelArray;
}

/** Inclusive range of stored values a raster can hold (or does hold). */
export interface StoredRange {
  readonly min: number;
  readonly max: number;
}

export function storedPixelType(data: StoredPixelArray): StoredPixelType {
  if (data instanceof Int16Array) return 'int16';
  if (data instanceof Uint16Array) return 'uint16';
  return 'uint8';
}

/** The full range the element type can represent. */
export function typeRange(type: StoredPixelType): StoredRange {
  switch (type) {
    case 'int16':
      return { min: -32768, max: 32767 };
    case 'uint16':
      return { min: 0, max: 65535 };
    case 'uint8':
      return { min: 0, max: 255 };
  }
}

/** Actual min/max over the raster's values. O(n). */
export function measureRange(data: StoredPixelArray): StoredRange {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return data.length === 0 ? { min: 0, max: 0 } : { min, max };
}

/** Allocate a stored-value array of the same element type. */
export function allocateLike(data: StoredPixelArray, length: number): StoredPixelArray {
  if (data instanceof Int16Array) return new Int16Array(length);
  if (data instanceof Uint16Array) return new Uint16Array(length);
  return new Uint8Array(length);
}
