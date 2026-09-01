/**
 * An immutable, tightly-cropped view of a mask's pixels.
 *
 * `data` is row-major over the `width x height` bounding box whose top-left
 * corner sits at (`x`, `y`) in **image-space pixels**; each entry is `0` or `1`.
 * `imageWidth` / `imageHeight` describe the full image the mask belongs to,
 * which formats like COCO RLE need in order to place the crop absolutely.
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
}

/** A rectangular region in image-space pixels. */
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
  /** Full image width in pixels. */
  readonly imageWidth: number;
  /** Full image height in pixels. */
  readonly imageHeight: number;
  /** Number of set (foreground) pixels. Maintained exactly. */
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
  /** Reads a pixel. Out-of-range coordinates read as `0`. */
  get(x: number, y: number): 0 | 1;
  /** Writes a pixel. Coordinates outside the image are ignored. */
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

/** Counts the foreground pixels in a snapshot. */
export function snapshotPixelCount(snapshot: MaskSnapshot): number {
  let count = 0;
  for (let i = 0; i < snapshot.data.length; i++) if (snapshot.data[i] === 1) count++;
  return count;
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
