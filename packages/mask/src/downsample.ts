import { MaskCapacityExceededError, type MaskRegion, type MaskSnapshot } from './mask-buffer.js';
import { toDenseSnapshot, type MaskRasterInput } from './mask-raster.js';

/** The placement fields a snapshot and a raster share. */
export type MaskBoxFields = Pick<
  MaskSnapshot,
  'cells' | 'imageWidth' | 'imageHeight' | 'downsample'
>;

/**
 * The coarsest grid a mask may be stored at: 2^16 image pixels per cell side.
 *
 * Chosen so that no image the codecs accept needs anything coarser: at
 * `MAX_IMAGE_SIDE` (2^26) a side, 2^16 leaves a 1024 x 1024 grid, a
 * sixty-fourth of the default pixel cap. `@osdlabel/validation` applies the
 * same bound as `MAX_MASK_DOWNSAMPLE`, and `osdlabel` asserts at compile time
 * that the two agree.
 */
export const MAX_MASK_DOWNSAMPLE = 65_536 as const;

/**
 * Whether `value` is a usable downsample: an integer power of two from 1 to
 * {@link MAX_MASK_DOWNSAMPLE}.
 *
 * Powers of two only, for three reasons. They are the factors a Deep Zoom
 * pyramid's levels sit at, so a mask can match the level it was drawn on.
 * Cells nest across them — one cell at 8 is exactly four at 4 — so a later
 * conversion between two of them is exact. And `x / d` stays an exact float
 * for every image coordinate, so placement never accumulates rounding.
 */
export function isMaskDownsample(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MASK_DOWNSAMPLE &&
    (value & (value - 1)) === 0
  );
}

/** Throws unless `value` passes {@link isMaskDownsample}. */
export function assertMaskDownsample(value: unknown): asserts value is number {
  if (!isMaskDownsample(value)) {
    throw new RangeError(
      `Mask downsample must be a power of two from 1 to ${MAX_MASK_DOWNSAMPLE}, got ${String(value)}`,
    );
  }
}

/** A snapshot's downsample, with the absent field read as `1`. */
export function maskDownsampleOf(snapshot: { readonly downsample?: number | undefined }): number {
  return snapshot.downsample ?? 1;
}

/**
 * The cell grid a whole image has at `downsample`: `ceil(side / downsample)`
 * cells a side — the same rounding a Deep Zoom pyramid uses for its levels.
 * The last column and row of cells are clipped by the image edge whenever a
 * side is not a multiple of the downsample.
 */
export function maskGridSize(
  imageWidth: number,
  imageHeight: number,
  downsample: number,
): { readonly width: number; readonly height: number } {
  return {
    width: Math.ceil(imageWidth / downsample),
    height: Math.ceil(imageHeight / downsample),
  };
}

/**
 * A mask's box in image (level-0) pixels, clipped to the image.
 *
 * At downsample 1 this is the cell box itself. Above it, cell `(cx, cy)`
 * covers image pixels `[cx * d, min((cx + 1) * d, imageWidth))` across and the
 * matching span down, so the box's far edges stop at the image's.
 */
export function snapshotImageBox(snapshot: MaskBoxFields): MaskRegion {
  const d = snapshot.downsample;
  const cells = snapshot.cells;
  // A box with no area is the empty mask, whatever origin it was left with —
  // in cells, which at d > 1 are not image pixels.
  if (cells.width === 0 || cells.height === 0) return { x: 0, y: 0, width: 0, height: 0 };
  if (d === 1) return { x: cells.x, y: cells.y, width: cells.width, height: cells.height };
  const x = cells.x * d;
  const y = cells.y * d;
  return {
    x,
    y,
    width: Math.min((cells.x + cells.width) * d, snapshot.imageWidth) - x,
    height: Math.min((cells.y + cells.height) * d, snapshot.imageHeight) - y,
  };
}

/**
 * Expands a downsampled snapshot to one cell per image pixel — the mask its
 * payload means, at full resolution.
 *
 * For a codec that only understands level-0 snapshots, and for tests. The
 * result is `downsample` squared times larger, so it is bounded by `maxPixels`
 * like any other allocation, and refused when it would not fit.
 */
export function upsampleSnapshot(input: MaskRasterInput, maxPixels: number): MaskSnapshot {
  const d = maskDownsampleOf(input);
  if (d === 1) return toDenseSnapshot(input, maxPixels);
  const box = snapshotImageBox(input);
  const area = box.width * box.height;
  if (area > maxPixels) throw new MaskCapacityExceededError(area, maxPixels);
  // The cell grid is d^2 smaller than the area just checked.
  const snapshot = toDenseSnapshot(input, Infinity);
  const data = new Uint8Array(area);
  for (let row = 0; row < box.height; row++) {
    const sourceRow = Math.floor(row / d) * snapshot.cells.width;
    const offset = row * box.width;
    for (let col = 0; col < box.width; col++) {
      if (snapshot.data[sourceRow + Math.floor(col / d)] === 1) data[offset + col] = 1;
    }
  }
  return {
    cells: { x: box.x, y: box.y, width: box.width, height: box.height },
    data,
    imageWidth: snapshot.imageWidth,
    imageHeight: snapshot.imageHeight,
    downsample: 1,
  };
}
