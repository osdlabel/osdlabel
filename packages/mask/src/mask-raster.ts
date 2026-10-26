import {
  assertBoxInsideImage,
  assertDecodableArea,
  assertDecodableOrigin,
  assertPixelDimensions,
} from './decode-guard.js';
import { assertMaskDownsample, maskGridSize } from './downsample.js';
import { emptySnapshot, type MaskCellBox, type MaskSnapshot } from './mask-buffer.js';

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
 * `Uint8Array` over the box ({@link MaskSnapshot}, wrapped by
 * {@link denseRaster}) is one implementation; the run list a canonical decode
 * produces is another, and allocates nothing the size of the box; a sparse
 * tiled store is a third. Anything that only reads a mask — the codecs, the
 * renderer, geometry — takes a `MaskRaster`, so swapping the storage behind it
 * changes no signature.
 *
 * **Grid conventions.** These hold for every raster, snapshot and payload:
 *
 * - `downsample` (`d`) is a power of two from 1 to `MAX_MASK_DOWNSAMPLE`
 *   (2^16): image pixels per cell along each axis.
 * - {@link MaskRaster.cells} is in cells. Cell `(cx, cy)` covers image pixels
 *   `[cx·d, min((cx+1)·d, imageWidth)) × [cy·d, min((cy+1)·d, imageHeight))`,
 *   anchored by its top-left corner; only the image's own last column and row
 *   of cells are clipped.
 * - `imageWidth` / `imageHeight` are always level-0 image pixels. The whole
 *   image's grid is `ceil(imageWidth / d) × ceil(imageHeight / d)` cells.
 * - In image pixels (`snapshotImageBox`, a payload's box, a mask geometry) the
 *   box's `x` and `y` are multiples of `d`, and so are its right and bottom
 *   edges, except where they are the image's own edges.
 * - Pixel counts (`snapshotPixelCount`, a geometry's `pixelCount`) are exact
 *   level-0 counts: a clipped edge cell counts at its clipped size.
 * - A format that centres pixels rather than anchoring them by a corner —
 *   OME-Zarr 0.6 — needs a translation of `(d − 1) / 2` image pixels on
 *   export.
 *
 * The box need not be tight, but every foreground cell lies inside it. An
 * empty mask has `cells.width === 0 && cells.height === 0`.
 */
export interface MaskRaster {
  /** The box, in cells. */
  readonly cells: MaskCellBox;
  /** The full image the mask belongs to, in image (level-0) pixels. */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Image pixels per cell along each axis: a power of two. Required, never implied. */
  readonly downsample: number;
  /** Foreground cells, exactly. */
  readonly cellCount: number;
  /** Reads one cell, in absolute cell coordinates. Anything outside the box reads `0`. */
  get(cx: number, cy: number): 0 | 1;
  /**
   * Visits the foreground spans, row by row from the top, left to right
   * within a row. Spans in a row are disjoint but may touch — a tiled store
   * splits a run at its tile edges — so a consumer that needs maximal runs
   * merges touching ones itself.
   *
   * With `within`, only the spans that intersect that cell box are visited,
   * each clipped to it, so a reader that needs a small region — a renderer's
   * tile, a proximity query — pays for that region and not for the mask.
   * The window is a hint a raster may honour or ignore: a raster that visits
   * every span regardless is still correct, and every reader in this package
   * clips again through {@link forEachCheckedSpan}.
   */
  forEachSpan(visit: MaskSpanVisitor, within?: MaskCellBox): void;
}

/** Anything a reading API accepts: a raster, or the dense snapshot a host built. */
export type MaskRasterInput = MaskRaster | MaskSnapshot;

/** Whether `value` is a {@link MaskRaster} rather than a plain dense snapshot. */
export function isMaskRaster(value: MaskRasterInput): value is MaskRaster {
  return typeof (value as Partial<MaskRaster>).forEachSpan === 'function';
}

/** The rows and columns two cell boxes share, or `null` when they share none. */
function intersect(a: MaskCellBox, b: MaskCellBox): MaskCellBox | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
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
 *
 * With `within`, spans are clipped to that cell box, and a span outside it is
 * skipped rather than refused: the window is a hint, and a raster that ignores
 * it is still valid. Every span is still checked against the contract above,
 * whichever window it falls in.
 */
export function forEachCheckedSpan(
  raster: MaskRaster,
  visit: MaskSpanVisitor,
  within?: MaskCellBox,
): void {
  const box = raster.cells;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const window = within === undefined ? box : intersect(box, within);
  if (window === null) return;
  const windowRight = window.x + window.width;
  const windowBottom = window.y + window.height;
  const clips = within !== undefined;
  let lastRow = -Infinity;
  let lastEnd = -Infinity;
  raster.forEachSpan(
    (cy, x0, x1) => {
      if (
        !Number.isInteger(cy) ||
        !Number.isInteger(x0) ||
        !Number.isInteger(x1) ||
        x1 <= x0 ||
        x0 < box.x ||
        x1 > right ||
        cy < box.y ||
        cy >= bottom
      ) {
        throw new RangeError(
          `Span ${x0}..${x1} on row ${cy} is empty or outside the ` +
            `${box.width}x${box.height} box at (${box.x}, ${box.y})`,
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
      if (!clips) {
        visit(cy, x0, x1);
        return;
      }
      if (cy < window.y || cy >= windowBottom) return;
      const left = Math.max(x0, window.x);
      const end = Math.min(x1, windowRight);
      if (end > left) visit(cy, left, end);
    },
    within === undefined ? undefined : window,
  );
}

/**
 * Receives one horizontal span of foreground **image** pixels: row `y`,
 * columns `[x0, x1)`, all in level-0 image coordinates.
 */
export type MaskLevel0SpanVisitor = (y: number, x0: number, x1: number) => void;

/**
 * Visits the level-0 image pixels a raster covers, as maximal horizontal
 * spans in row-major order — the mask its payload means, without
 * materialising it.
 *
 * For an exporter whose format has no downsample (DICOM SEG, NIfTI, a label
 * image): each cell row becomes the `d` image rows it covers, each cell span
 * the image columns it covers, and the image's own last row and column are
 * clipped at its edge. Touching spans in a row are merged. Work is
 * proportional to the image rows covered times the spans per row, never to
 * the box's area.
 */
/**
 * Refuses a raster whose box breaks the grid conventions: a factor that is not
 * a power of two, a fractional or negative origin, or a box outside its
 * image's cell grid. The encoders and the buffer already refuse such input;
 * the readers that turn cells into image pixels check it here, so they do not
 * clip, or place at negative image columns, what the writers would refuse.
 * Applied to any raster, including a host's own.
 */
function assertRasterOnGrid(raster: MaskRaster): void {
  const { x, y, width, height } = raster.cells;
  assertMaskDownsample(raster.downsample);
  assertDecodableOrigin(x, y);
  assertPixelDimensions(width, height);
  const grid = maskGridSize(raster.imageWidth, raster.imageHeight, raster.downsample);
  assertBoxInsideImage(x, y, width, height, grid.width, grid.height);
}

export function forEachLevel0Span(raster: MaskRaster, visit: MaskLevel0SpanVisitor): void {
  if (raster.cells.width > 0 && raster.cells.height > 0) assertRasterOnGrid(raster);
  const d = raster.downsample;
  const { imageWidth, imageHeight } = raster;
  let row = -1;
  // The current cell row's spans, merged, as [x0, x1) cell pairs.
  let spans: number[] = [];
  const flush = (): void => {
    if (row < 0 || spans.length === 0) return;
    const top = row * d;
    const bottom = Math.min((row + 1) * d, imageHeight);
    for (let y = top; y < bottom; y++) {
      for (let i = 0; i < spans.length; i += 2) {
        visit(y, spans[i]! * d, Math.min(spans[i + 1]! * d, imageWidth));
      }
    }
  };
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    if (cy !== row) {
      flush();
      row = cy;
      spans = [x0, x1];
      return;
    }
    if (spans[spans.length - 1] === x0) spans[spans.length - 1] = x1;
    else spans.push(x0, x1);
  });
  flush();
}

/** A dense snapshot behind the {@link MaskRaster} interface; the box is not copied. */
class DenseMaskRaster implements MaskRaster {
  readonly cells: MaskCellBox;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly downsample: number;
  /** The snapshot this wraps, handed back by {@link toDenseSnapshot} without a copy. */
  readonly dense: MaskSnapshot;
  private count: number | undefined;

  constructor(snapshot: MaskSnapshot) {
    // The data is the box's cells, row-major: nothing else. A shorter array
    // read its missing cells as clear, and a longer one was counted but never
    // drawn or encoded — both silently, now that codecs return rasters.
    const { width, height } = snapshot.cells;
    assertPixelDimensions(width, height);
    if (snapshot.data.length !== width * height) {
      throw new RangeError(
        `Snapshot data has ${snapshot.data.length} pixels but its box describes ${width * height}`,
      );
    }
    this.dense = snapshot;
    this.cells = snapshot.cells;
    this.imageWidth = snapshot.imageWidth;
    this.imageHeight = snapshot.imageHeight;
    this.downsample = snapshot.downsample;
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
    const { x, y, width, height } = this.cells;
    const col = cx - x;
    const row = cy - y;
    if (col < 0 || row < 0 || col >= width || row >= height) return 0;
    return this.dense.data[row * width + col] === 1 ? 1 : 0;
  }

  forEachSpan(visit: MaskSpanVisitor, within?: MaskCellBox): void {
    const box = this.cells;
    const window = within === undefined ? box : intersect(box, within);
    if (window === null) return;
    const { width } = box;
    const data = this.dense.data;
    const firstCol = window.x - box.x;
    const endCol = firstCol + window.width;
    for (let row = window.y - box.y; row < window.y - box.y + window.height; row++) {
      const offset = row * width;
      let col = firstCol;
      while (col < endCol) {
        if (data[offset + col] !== 1) {
          col++;
          continue;
        }
        const start = col;
        while (col < endCol && data[offset + col] === 1) col++;
        visit(box.y + row, box.x + start, box.x + col);
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
 * readable.
 */
class RunMaskRaster implements MaskRaster {
  readonly cellCount: number;

  constructor(
    readonly cells: MaskCellBox,
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

  /** The last run starting at or before box-relative `index`, or -1. */
  private runAtOrBefore(index: number): number {
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
    return found;
  }

  get(cx: number, cy: number): 0 | 1 {
    const { x, y, width, height } = this.cells;
    const col = cx - x;
    const row = cy - y;
    if (col < 0 || row < 0 || col >= width || row >= height) return 0;
    const index = row * width + col;
    const found = this.runAtOrBefore(index);
    return found >= 0 && index < this.starts[found]! + this.lengths[found]! ? 1 : 0;
  }

  forEachSpan(visit: MaskSpanVisitor, within?: MaskCellBox): void {
    const box = this.cells;
    const window = within === undefined ? box : intersect(box, within);
    if (window === null) return;
    const width = box.width;
    const firstRow = window.y - box.y;
    const endRow = firstRow + window.height;
    const firstCol = window.x - box.x;
    const endCol = firstCol + window.width;
    // Binary search to the run that reaches the window's first row, so a
    // window near the bottom of a large mask skips every run above it.
    const startIndex = firstRow * width;
    let i = Math.max(0, this.runAtOrBefore(startIndex));
    const stopIndex = endRow * width;
    for (; i < this.starts.length; i++) {
      let index = Math.max(this.starts[i]!, startIndex);
      const end = this.starts[i]! + this.lengths[i]!;
      if (this.starts[i]! >= stopIndex) break;
      // A run wraps across rows; cut it at each row end.
      while (index < end && index < stopIndex) {
        const row = Math.floor(index / width);
        const col = index - row * width;
        const stop = Math.min(end, (row + 1) * width);
        const left = Math.max(col, firstCol);
        const right = Math.min(col + (stop - index), endCol);
        if (right > left) visit(box.y + row, box.x + left, box.x + right);
        index = stop;
      }
    }
  }
}

/**
 * Wraps alternating run lengths (starting with background, row-major over the
 * cell box) as a raster, without expanding them.
 *
 * The runs must sum to exactly the box's cell count, as `fromRuns` demands.
 */
export function runRaster(
  box: Pick<MaskRaster, 'cells' | 'imageWidth' | 'imageHeight' | 'downsample'>,
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
  const area = box.cells.width * box.cells.height;
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
    { ...box.cells },
    box.imageWidth,
    box.imageHeight,
    box.downsample,
    starts,
    lengths,
  );
}

/**
 * Alternating run lengths, starting with background, row-major over the
 * raster's cell box — what `toRuns` gives for the dense box, computed from
 * spans so the box is never allocated. Touching spans are merged.
 */
export function rasterToRuns(raster: MaskRaster): number[] {
  const runs: number[] = [];
  const box = raster.cells;
  const width = box.width;
  let end = 0; // box-relative linear index just past the last foreground run
  let open = -1; // start of the foreground run being extended, or -1
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    const start = (cy - box.y) * width + (x0 - box.x);
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
  const area = box.width * box.height;
  if (end < area || runs.length === 0) runs.push(area - end);
  return runs;
}

/**
 * Materialises a raster as a dense snapshot over its box — the one place a
 * reader pays for the box rather than for the runs.
 *
 * Refused above `maxCells` cells (default: the decode cap). A raster that
 * already wraps a dense snapshot hands it back without a copy.
 */
export function toDenseSnapshot(raster: MaskRasterInput, maxCells?: number): MaskSnapshot {
  if (!isMaskRaster(raster)) return raster;
  if (raster instanceof DenseMaskRaster) return raster.dense;
  const box = raster.cells;
  if (box.width === 0 || box.height === 0) {
    return emptySnapshot(raster.imageWidth, raster.imageHeight);
  }
  assertRasterOnGrid(raster);
  assertDecodableArea(box.width, box.height, maxCells, raster.downsample);
  const data = new Uint8Array(box.width * box.height);
  const { x, y, width } = box;
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    const offset = (cy - y) * width - x;
    data.fill(1, offset + x0, offset + x1);
  });
  return {
    cells: { x, y, width, height: box.height },
    data,
    imageWidth: raster.imageWidth,
    imageHeight: raster.imageHeight,
    downsample: raster.downsample,
  };
}

/**
 * The image (level-0) pixels a raster's foreground covers — exact at every
 * downsample, in O(spans): cells on the image's clipped last column and row
 * count at their clipped size.
 */
export function rasterPixelCount(raster: MaskRaster): number {
  const box = raster.cells;
  if (box.width === 0 || box.height === 0) return 0;
  assertRasterOnGrid(raster);
  const d = raster.downsample;
  // Counted from the spans at every downsample, never taken from `cellCount`:
  // a host raster's count is a claim, and the geometry written from this
  // would disagree with the payload until the next round trip replaced it.
  if (d === 1) {
    let cells = 0;
    forEachCheckedSpan(raster, (_cy, x0, x1) => {
      cells += x1 - x0;
    });
    return cells;
  }
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
