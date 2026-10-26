import {
  isMaskRaster,
  rasterPixelCount,
  type MaskRaster,
  type MaskRasterInput,
} from './mask-raster.js';

/**
 * A box on a mask's **cell** grid: `x` / `y` / `width` / `height` count cells
 * at the mask's downsample, never image pixels.
 *
 * It is nested (`snapshot.cells`, `raster.cells`) rather than spread onto the
 * snapshot so that code reading it has to say which space it means. A
 * downsampled mask's box in image pixels is `snapshotImageBox(snapshot)`;
 * reading `cells.width` as image pixels is the mistake this shape makes
 * visible, and a top-level `snapshot.width` no longer compiles.
 *
 * An empty mask's box is `width === 0 && height === 0`.
 */
export interface MaskCellBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * An immutable, tightly-cropped view of a mask's cells, as a dense array —
 * the shape a host that computed pixels itself (a model's output, a decoded
 * file) hands in. Readers take a {@link MaskRaster}; `denseRaster` wraps
 * this as one.
 *
 * `data` is row-major over {@link MaskSnapshot.cells}, one entry per cell, each
 * `0` or `1`. The grid conventions are the same as a raster's; see
 * {@link MaskRaster}.
 */
export interface MaskSnapshot {
  /** The box, in cells. */
  readonly cells: MaskCellBox;
  readonly data: Uint8Array;
  /** The full image the mask belongs to, in image (level-0) pixels. */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Image pixels per cell along each axis: a power of two. Required, never implied. */
  readonly downsample: number;
}

/** A rectangular region — in image pixels or mask cells, as each use says. */
export interface MaskRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Mutable pixel storage for a single mask annotation.
 *
 * Coordinates are absolute **cell** integers (image pixels at downsample 1),
 * so callers never think about the buffer's internal placement. Writes
 * outside the image are ignored; writes outside the currently allocated
 * region grow it (see {@link BoundedDenseMaskBuffer}).
 *
 * Its output is a {@link MaskRaster}, not a dense array, so the readers — the
 * codecs, the renderer, geometry — keep their signatures if a tiled sparse
 * buffer replaces the bounded dense one. Not everything does: the brush
 * densifies the mask it refines into a dense buffer, and paints its live
 * preview as one canvas over the buffer's box, so a sparse store needs both
 * of those rewritten too.
 */
export interface MaskBuffer {
  /** Full image width in image (level-0) pixels. */
  readonly imageWidth: number;
  /** Full image height in image (level-0) pixels. */
  readonly imageHeight: number;
  /**
   * Image pixels per cell along each axis (a power of two; 1 = one cell per
   * image pixel). Fixed for the buffer's lifetime.
   */
  readonly downsample: number;
  /** Cells across the whole image: `ceil(imageWidth / downsample)`. */
  readonly gridWidth: number;
  /** Cells down the whole image: `ceil(imageHeight / downsample)`. */
  readonly gridHeight: number;
  /** Number of set (foreground) cells. Maintained exactly. */
  readonly cellCount: number;
  /**
   * The cells this buffer can currently address without growing. Always a
   * superset of the set cells, and typically larger than the tight box
   * `raster()` returns.
   *
   * Renderers use this to size an offscreen canvas once and repaint only the
   * cells a stroke touched, rather than copying the whole mask each frame.
   */
  readonly cellBounds: MaskCellBox;
  /** Reads a cell. Out-of-range coordinates read as `0`. */
  get(x: number, y: number): 0 | 1;
  /** Writes a cell. Coordinates outside the image's grid are ignored. */
  set(x: number, y: number, value: 0 | 1): void;
  /**
   * Grows the addressable region to cover `region` (clipped to the image) in
   * one step, so a caller that knows the extent it is about to paint pays for
   * a single reallocation instead of one per edge it crosses.
   *
   * It also bounds how much of a failed paint is visible. Capacity is the only
   * thing painting can fail on, so reserving first means
   * {@link MaskCapacityExceededError} is raised before any pixel is written —
   * making each stamp and each swept segment atomic.
   *
   * That is per *call*, not per stroke: a multi-segment stroke whose later
   * segment overflows leaves the earlier ones painted in the buffer. Whole-
   * stroke atomicity is the tool's job, and it gets it by discarding the
   * buffer rather than committing — so the mask *annotation* is unchanged even
   * though the buffer was not.
   *
   * Optional — implementations that never reallocate (or grow lazily) may omit
   * it, and callers must treat its absence as a no-op.
   */
  reserve?(region: MaskRegion): void;
  /**
   * A tightly-cropped, read-only view of the current cells, detached from
   * later writes. Its storage is the implementation's business.
   */
  raster(): MaskRaster;
}

/** Thrown when a mask would need to allocate more pixels than its configured cap. */
export class MaskCapacityExceededError extends Error {
  readonly requestedPixels: number;
  readonly maxPixels: number;

  constructor(requestedPixels: number, maxPixels: number) {
    super(
      `Mask would require ${requestedPixels} pixels, exceeding the ${maxPixels} pixel cap. ` +
        `Paint in a more localized region or raise maxPixels.`,
    );
    this.name = 'MaskCapacityExceededError';
    this.requestedPixels = requestedPixels;
    this.maxPixels = maxPixels;
  }
}

/** Counts the foreground cells in a mask (image pixels at downsample 1). */
export function snapshotCellCount(input: MaskRasterInput): number {
  if (isMaskRaster(input)) return input.cellCount;
  const snapshot = input;
  let count = 0;
  for (let i = 0; i < snapshot.data.length; i++) if (snapshot.data[i] === 1) count++;
  return count;
}

/**
 * Counts the image (level-0) pixels a snapshot's foreground covers — exact at
 * every downsample.
 *
 * Each cell covers `d x d` image pixels except along the image's right and
 * bottom edges, where a side that is not a multiple of `d` clips the last
 * column and row of cells. Those are counted at their clipped size, so this
 * equals the foreground of `upsampleSnapshot(snapshot)` without building it.
 */
export function snapshotPixelCount(input: MaskRasterInput): number {
  if (isMaskRaster(input)) return rasterPixelCount(input);
  const snapshot = input;
  const d = snapshot.downsample;
  if (d === 1) return snapshotCellCount(snapshot);
  const { data, imageWidth, imageHeight } = snapshot;
  const { x, y, width, height } = snapshot.cells;
  // Image pixels covered by the last cell of a column / row, which is the only
  // one the image edge can clip.
  const lastCol = Math.ceil(imageWidth / d) - 1;
  const lastRow = Math.ceil(imageHeight / d) - 1;
  const lastColWidth = imageWidth - lastCol * d;
  const lastRowHeight = imageHeight - lastRow * d;
  const edgeCol = lastCol - x; // index within the box, or out of range
  let total = 0;
  for (let row = 0; row < height; row++) {
    const offset = row * width;
    let cells = 0;
    for (let col = 0; col < width; col++) if (data[offset + col] === 1) cells++;
    if (cells === 0) continue;
    let across = cells * d;
    if (edgeCol >= 0 && edgeCol < width && data[offset + edgeCol] === 1) {
      across -= d - lastColWidth;
    }
    total += across * (y + row === lastRow ? lastRowHeight : d);
  }
  return total;
}

/** An empty snapshot for an image of the given size, at downsample 1. */
export function emptySnapshot(imageWidth: number, imageHeight: number): MaskSnapshot {
  return {
    cells: { x: 0, y: 0, width: 0, height: 0 },
    data: new Uint8Array(0),
    imageWidth,
    imageHeight,
    downsample: 1,
  };
}
