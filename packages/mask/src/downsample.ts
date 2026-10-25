import { MaskCapacityExceededError, type MaskRegion, type MaskSnapshot } from './mask-buffer.js';

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
 * A snapshot's bounding box in image (level-0) pixels, clipped to the image.
 *
 * At downsample 1 this is the snapshot's own box. Above it, cell `(cx, cy)`
 * covers image pixels `[cx * d, min((cx + 1) * d, imageWidth))` across and the
 * matching span down, so the box's far edges stop at the image's.
 */
export function snapshotImageBox(snapshot: MaskSnapshot): MaskRegion {
  const d = maskDownsampleOf(snapshot);
  if (d === 1 || snapshot.width === 0 || snapshot.height === 0) {
    return { x: snapshot.x, y: snapshot.y, width: snapshot.width, height: snapshot.height };
  }
  const x = snapshot.x * d;
  const y = snapshot.y * d;
  return {
    x,
    y,
    width: Math.min((snapshot.x + snapshot.width) * d, snapshot.imageWidth) - x,
    height: Math.min((snapshot.y + snapshot.height) * d, snapshot.imageHeight) - y,
  };
}

/**
 * Cells a region needs at `downsample`: its grid-aligned cover, clipped to
 * the image's grid. Alignment matters — a region that straddles cell
 * boundaries needs one more cell a side than its size alone suggests.
 */
function cellsFor(
  region: MaskRegion,
  imageWidth: number,
  imageHeight: number,
  downsample: number,
  marginCells: number,
): number {
  const grid = maskGridSize(imageWidth, imageHeight, downsample);
  const left = Math.max(0, Math.floor(region.x / downsample) - marginCells);
  const top = Math.max(0, Math.floor(region.y / downsample) - marginCells);
  const right = Math.min(
    grid.width,
    Math.ceil((region.x + region.width) / downsample) + marginCells,
  );
  const bottom = Math.min(
    grid.height,
    Math.ceil((region.y + region.height) / downsample) + marginCells,
  );
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * The finest downsample at which `region` (image pixels) fits in `maxPixels`
 * cells: the smallest power of two that does.
 *
 * This is what decides a new mask's resolution. The brush passes the part of
 * the image on screen, so a stroke that stays in view always fits; a
 * segmentation model would pass its prediction's box. A region that fits at 1
 * gets 1, which is exactly the behaviour before the field existed.
 *
 * `marginCells` widens the region by that many cells a side at each candidate
 * downsample — room for the slack a rasterizer reserves around a stamp, which
 * is a cell count rather than an image distance.
 *
 * Throws {@link MaskCapacityExceededError} when even
 * {@link MAX_MASK_DOWNSAMPLE} does not fit, which only a cap far below the
 * default can cause.
 */
export function chooseMaskDownsample(
  region: MaskRegion,
  imageWidth: number,
  imageHeight: number,
  maxPixels: number,
  marginCells = 0,
): number {
  for (let d = 1; d <= MAX_MASK_DOWNSAMPLE; d *= 2) {
    if (cellsFor(region, imageWidth, imageHeight, d, marginCells) <= maxPixels) return d;
  }
  throw new MaskCapacityExceededError(
    cellsFor(region, imageWidth, imageHeight, MAX_MASK_DOWNSAMPLE, marginCells),
    maxPixels,
  );
}

/**
 * Expands a downsampled snapshot to one cell per image pixel — the mask its
 * payload means, at full resolution.
 *
 * For a codec that only understands level-0 snapshots, and for tests. The
 * result is `downsample` squared times larger, so it is bounded by `maxPixels`
 * like any other allocation, and refused when it would not fit.
 */
export function upsampleSnapshot(snapshot: MaskSnapshot, maxPixels: number): MaskSnapshot {
  const d = maskDownsampleOf(snapshot);
  if (d === 1) return snapshot;
  const box = snapshotImageBox(snapshot);
  const area = box.width * box.height;
  if (area > maxPixels) throw new MaskCapacityExceededError(area, maxPixels);
  const data = new Uint8Array(area);
  for (let row = 0; row < box.height; row++) {
    const sourceRow = Math.floor(row / d) * snapshot.width;
    const offset = row * box.width;
    for (let col = 0; col < box.width; col++) {
      if (snapshot.data[sourceRow + Math.floor(col / d)] === 1) data[offset + col] = 1;
    }
  }
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    data,
    imageWidth: snapshot.imageWidth,
    imageHeight: snapshot.imageHeight,
  };
}
