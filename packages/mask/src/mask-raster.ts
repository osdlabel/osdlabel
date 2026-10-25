import { assertDecodableArea } from './decode-guard.js';
import { emptySnapshot, type MaskSnapshot } from './mask-buffer.js';

/**
 * Receives one horizontal span of foreground cells: row `cy`, columns
 * `[x0, x1)`, all in absolute **cell** coordinates.
 */
export type MaskSpanVisitor = (cy: number, x0: number, x1: number) => void;

/**
 * A read-only view of a mask's cells that makes no promise about how they are
 * stored.
 *
 * This is the currency between storage, codecs and renderers. A dense
 * `Uint8Array` over the bounding box ({@link MaskSnapshot}, wrapped by
 * {@link denseRaster}) is one implementation; the run list a canonical decode
 * produces is another, and allocates nothing the size of the box; a sparse
 * tiled store is a third. Anything that only reads a mask — the codecs, the
 * renderer, geometry — takes a `MaskRaster`, so swapping the storage behind it
 * changes no signature.
 *
 * Coordinates are in cells at {@link MaskRaster.downsample}: cell `(cx, cy)`
 * covers image pixels `[cx * d, (cx + 1) * d)` across and the matching span
 * down, clipped by the image edge. `imageWidth` / `imageHeight` are level-0.
 *
 * The box need not be tight, but every foreground cell lies inside it. An
 * empty mask has `width === 0 && height === 0`.
 */
export interface MaskRaster {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Image pixels per cell along each axis: a power of two. Required, never implied. */
  readonly downsample: number;
  /** Foreground cells, exactly. */
  readonly cellCount: number;
  /** Reads one cell, in absolute cell coordinates. Anything outside the box reads `0`. */
  get(cx: number, cy: number): 0 | 1;
  /**
   * Visits every foreground span, row by row from the top, left to right
   * within a row. Spans in a row are disjoint but may touch — a tiled store
   * splits a run at its tile edges — so a consumer that needs maximal runs
   * merges touching ones itself.
   */
  forEachSpan(visit: MaskSpanVisitor): void;
}

/** Anything a reading API accepts: a raster, or the dense snapshot a host built. */
export type MaskRasterInput = MaskRaster | MaskSnapshot;

/** Whether `value` is a {@link MaskRaster} rather than a plain dense snapshot. */
export function isMaskRaster(value: MaskRasterInput): value is MaskRaster {
  return typeof (value as Partial<MaskRaster>).forEachSpan === 'function';
}

/**
 * {@link MaskRaster.forEachSpan} with its contract enforced: every span
 * non-empty, on whole cells, inside the box, and in row-major order without
 * overlap.
 *
 * A raster a host implemented can break any of these, and each consumer would
 * turn the break into a plausible wrong mask rather than an error — the
 * canonical runs would go negative, the COCO sweep would toggle a row that
 * was never on. Every reader in this package goes through here.
 */
export function forEachCheckedSpan(raster: MaskRaster, visit: MaskSpanVisitor): void {
  const right = raster.x + raster.width;
  const bottom = raster.y + raster.height;
  let lastRow = -Infinity;
  let lastEnd = -Infinity;
  raster.forEachSpan((cy, x0, x1) => {
    if (
      !Number.isInteger(cy) ||
      !Number.isInteger(x0) ||
      !Number.isInteger(x1) ||
      x1 <= x0 ||
      x0 < raster.x ||
      x1 > right ||
      cy < raster.y ||
      cy >= bottom
    ) {
      throw new RangeError(
        `Span ${x0}..${x1} on row ${cy} is empty or outside the ` +
          `${raster.width}x${raster.height} box at (${raster.x}, ${raster.y})`,
      );
    }
    if (cy < lastRow || (cy === lastRow && x0 < lastEnd)) {
      throw new RangeError(
        `Spans must be row-major and disjoint: ${x0}..${x1} on row ${cy} ` +
          `follows one ending at ${lastEnd} on row ${lastRow}`,
      );
    }
    lastRow = cy;
    lastEnd = x1;
    visit(cy, x0, x1);
  });
}

/** A dense snapshot behind the {@link MaskRaster} interface; the box is not copied. */
class DenseMaskRaster implements MaskRaster {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly downsample: number;
  /** The snapshot this wraps, handed back by {@link toDenseSnapshot} without a copy. */
  readonly dense: MaskSnapshot;
  private count: number | undefined;

  constructor(snapshot: MaskSnapshot) {
    this.dense = snapshot;
    this.x = snapshot.x;
    this.y = snapshot.y;
    this.width = snapshot.width;
    this.height = snapshot.height;
    this.imageWidth = snapshot.imageWidth;
    this.imageHeight = snapshot.imageHeight;
    this.downsample = snapshot.downsample ?? 1;
  }

  get cellCount(): number {
    if (this.count === undefined) {
      let count = 0;
      const data = this.dense.data;
      for (let i = 0; i < data.length; i++) if (data[i] === 1) count++;
      this.count = count;
    }
    return this.count;
  }

  get(cx: number, cy: number): 0 | 1 {
    const col = cx - this.x;
    const row = cy - this.y;
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return 0;
    return this.dense.data[row * this.width + col] === 1 ? 1 : 0;
  }

  forEachSpan(visit: MaskSpanVisitor): void {
    const { width, height } = this;
    const data = this.dense.data;
    for (let row = 0; row < height; row++) {
      const offset = row * width;
      let col = 0;
      while (col < width) {
        if (data[offset + col] !== 1) {
          col++;
          continue;
        }
        const start = col;
        while (col < width && data[offset + col] === 1) col++;
        visit(this.y + row, this.x + start, this.x + col);
      }
    }
  }
}

/** Puts a dense snapshot behind the {@link MaskRaster} interface, without copying it. */
export function denseRaster(snapshot: MaskSnapshot): MaskRaster {
  return new DenseMaskRaster(snapshot);
}

/** A raster as-is, or a dense snapshot wrapped as one. */
export function asMaskRaster(input: MaskRasterInput): MaskRaster {
  return isMaskRaster(input) ? input : denseRaster(input);
}

/**
 * Row-major runs over a box, kept as runs: what a canonical decode produces.
 *
 * Memory is proportional to the number of foreground runs, never to the box,
 * so a mask whose box is far beyond what a dense array could hold is still
 * readable — which is what lets the dense cap be a policy of the consumers
 * that materialise, rather than a property of the format.
 */
class RunMaskRaster implements MaskRaster {
  readonly cellCount: number;

  constructor(
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
    readonly imageWidth: number,
    readonly imageHeight: number,
    readonly downsample: number,
    /** Box-relative linear index of each foreground run's first cell, ascending. */
    private readonly starts: Float64Array,
    /** Length of each foreground run, in cells. */
    private readonly lengths: Float64Array,
  ) {
    let count = 0;
    for (let i = 0; i < lengths.length; i++) count += lengths[i]!;
    this.cellCount = count;
  }

  get(cx: number, cy: number): 0 | 1 {
    const col = cx - this.x;
    const row = cy - this.y;
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return 0;
    const index = row * this.width + col;
    // The last run starting at or before `index`.
    let lo = 0;
    let hi = this.starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid]! <= index) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && index < this.starts[found]! + this.lengths[found]! ? 1 : 0;
  }

  forEachSpan(visit: MaskSpanVisitor): void {
    const width = this.width;
    for (let i = 0; i < this.starts.length; i++) {
      let index = this.starts[i]!;
      const end = index + this.lengths[i]!;
      // A run wraps across rows; cut it at each row end.
      while (index < end) {
        const row = Math.floor(index / width);
        const col = index - row * width;
        const stop = Math.min(end, (row + 1) * width);
        visit(this.y + row, this.x + col, this.x + col + (stop - index));
        index = stop;
      }
    }
  }
}

/**
 * Wraps alternating run lengths (starting with background, row-major over a
 * `width x height` cell box) as a raster, without expanding them.
 *
 * The runs must sum to exactly `width * height`, as `fromRuns` demands.
 */
export function runRaster(
  box: Pick<
    MaskRaster,
    'x' | 'y' | 'width' | 'height' | 'imageWidth' | 'imageHeight' | 'downsample'
  >,
  runs: readonly number[],
): MaskRaster {
  let total = 0;
  let foregroundRuns = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (!Number.isInteger(run) || run < 0) {
      throw new RangeError(`Run lengths must be non-negative integers, got ${run}`);
    }
    total += run;
    if (i % 2 === 1 && run > 0) foregroundRuns++;
  }
  const area = box.width * box.height;
  if (total !== area) {
    throw new RangeError(`Run lengths sum to ${total}, but the box holds ${area} pixels`);
  }
  const starts = new Float64Array(foregroundRuns);
  const lengths = new Float64Array(foregroundRuns);
  let index = 0;
  let k = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (i % 2 === 1 && run > 0) {
      starts[k] = index;
      lengths[k] = run;
      k++;
    }
    index += run;
  }
  return new RunMaskRaster(
    box.x,
    box.y,
    box.width,
    box.height,
    box.imageWidth,
    box.imageHeight,
    box.downsample,
    starts,
    lengths,
  );
}

/**
 * Alternating run lengths, starting with background, row-major over the
 * raster's box — what `toRuns` gives for the dense box, computed from spans
 * so the box is never allocated. Touching spans are merged.
 */
export function rasterToRuns(raster: MaskRaster): number[] {
  const runs: number[] = [];
  const width = raster.width;
  let end = 0; // box-relative linear index just past the last foreground run
  let open = -1; // start of the foreground run being extended, or -1
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    const start = (cy - raster.y) * width + (x0 - raster.x);
    const stop = start + (x1 - x0);
    if (open >= 0 && start === end) {
      end = stop;
      return;
    }
    if (open >= 0) runs.push(end - open);
    runs.push(start - end);
    open = start;
    end = stop;
  });
  if (open >= 0) runs.push(end - open);
  const area = raster.width * raster.height;
  if (end < area || runs.length === 0) runs.push(area - end);
  return runs;
}

/**
 * Materialises a raster as a dense snapshot over its box — the one place a
 * reader pays for the box rather than for the runs.
 *
 * Refused above `maxCells` (default: the decode cap), so the dense cap is the
 * policy of whoever calls this, not something every reader inherits. A raster
 * that already wraps a dense snapshot hands it back without a copy.
 */
export function toDenseSnapshot(raster: MaskRasterInput, maxCells?: number): MaskSnapshot {
  if (!isMaskRaster(raster)) return raster;
  if (raster instanceof DenseMaskRaster) return raster.dense;
  if (raster.width === 0 || raster.height === 0) {
    return emptySnapshot(raster.imageWidth, raster.imageHeight);
  }
  assertDecodableArea(raster.width, raster.height, maxCells);
  const data = new Uint8Array(raster.width * raster.height);
  const { x, y, width } = raster;
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    const offset = (cy - y) * width - x;
    data.fill(1, offset + x0, offset + x1);
  });
  return {
    x,
    y,
    width,
    height: raster.height,
    data,
    imageWidth: raster.imageWidth,
    imageHeight: raster.imageHeight,
    ...(raster.downsample !== 1 ? { downsample: raster.downsample } : {}),
  };
}

/**
 * The image (level-0) pixels a raster's foreground covers — exact at every
 * downsample, in O(spans): cells on the image's clipped last column and row
 * count at their clipped size.
 */
export function rasterPixelCount(raster: MaskRaster): number {
  const d = raster.downsample;
  if (d === 1) return raster.cellCount;
  const lastCol = Math.ceil(raster.imageWidth / d) - 1;
  const lastRow = Math.ceil(raster.imageHeight / d) - 1;
  const clipCol = d - (raster.imageWidth - lastCol * d);
  const lastRowHeight = raster.imageHeight - lastRow * d;
  let total = 0;
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    let across = (x1 - x0) * d;
    if (x1 - 1 === lastCol) across -= clipCol;
    total += across * (cy === lastRow ? lastRowHeight : d);
  });
  return total;
}
