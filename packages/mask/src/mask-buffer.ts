/**
 * An immutable, tightly-cropped view of a mask's pixels.
 *
 * `data` is row-major over the `width x height` bounding box whose top-left
 * corner sits at (`x`, `y`) in **mask cells**; each entry is `0` or `1`.
 * At the default `downsample` of 1 a cell is an image pixel, so these are
 * image-space pixels. At a downsample `d` above 1, cell (`cx`, `cy`) covers
 * image pixels `[cx * d, (cx + 1) * d)` across and the matching span down,
 * clipped by the image edge — see `snapshotImageBox` for the box in image
 * pixels.
 *
 * `imageWidth` / `imageHeight` always describe the full image the mask belongs
 * to in image (level-0) pixels, which formats like COCO RLE need in order to
 * place the crop absolutely. The cell grid of the whole image is
 * `ceil(imageWidth / d) x ceil(imageHeight / d)`.
 *
 * An empty mask is represented by `width === 0 && height === 0`.
 */
export interface MaskSnapshot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Image pixels per cell along each axis; a power of two. Absent means 1. */
  readonly downsample?: number;
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
 * Coordinates are absolute **image-space** integers, so callers never think
 * about the buffer's internal placement. Writes outside the image are ignored;
 * writes outside the currently allocated region grow it (see
 * {@link BoundedDenseMaskBuffer}).
 *
 * This interface is the seam that keeps the storage strategy swappable: the
 * brush tool, the codecs, and the renderer all speak `MaskBuffer` /
 * {@link MaskSnapshot}, so a tiled sparse implementation can replace the
 * bounded dense one without touching them.
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
  readonly pixelCount: number;
  /**
   * The region this buffer can currently address without growing. Always a
   * superset of the set pixels, and typically larger than the tight bounding
   * box `snapshot()` returns.
   *
   * Renderers use this to size an offscreen canvas once and repaint only the
   * pixels a stroke touched, rather than copying the whole mask each frame.
   */
  readonly bounds: MaskRegion;
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
  /** Produces a tightly-cropped, copied snapshot of the current pixels. */
  snapshot(): MaskSnapshot;
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

/** Counts the foreground cells in a snapshot (image pixels at downsample 1). */
export function snapshotCellCount(snapshot: MaskSnapshot): number {
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
export function snapshotPixelCount(snapshot: MaskSnapshot): number {
  const d = snapshot.downsample ?? 1;
  if (d === 1) return snapshotCellCount(snapshot);
  const { x, y, width, height, data, imageWidth, imageHeight } = snapshot;
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

/** An empty snapshot for an image of the given size. */
export function emptySnapshot(imageWidth: number, imageHeight: number): MaskSnapshot {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    data: new Uint8Array(0),
    imageWidth,
    imageHeight,
  };
}
