import {
  assertBoxInsideImage,
  assertCountableImage,
  assertDecodableArea,
  assertDecodableCount,
  assertDecodableOrigin,
  assertPixelDimensions,
} from './decode-guard.js';
import { DEFAULT_MAX_MASK_PIXELS } from './bounded-dense-mask-buffer.js';
import { emptySnapshot, snapshotPixelCount, type MaskSnapshot } from './mask-buffer.js';
import type { MaskCodec, MaskDecodeOptions } from './mask-codec.js';
import {
  assertMaskDownsample,
  maskGridSize,
  snapshotImageBox,
  type MaskBoxFields,
} from './downsample.js';
import {
  asMaskRaster,
  denseRaster,
  forEachCheckedSpan,
  type MaskRasterInput,
} from './mask-raster.js';

export const COCO_RLE_FORMAT = 'coco-rle';
export const COCO_RLE_UNCOMPRESSED_FORMAT = 'coco-rle-uncompressed';

/** COCO's `segmentation` object with LEB128-style compressed counts. */
export interface CocoRleSegmentation {
  /** `[height, width]` of the **full image**, per the COCO spec. */
  readonly size: readonly [number, number];
  readonly counts: string;
}

/** COCO's `segmentation` object with plain integer run lengths. */
export interface CocoRleUncompressedSegmentation {
  readonly size: readonly [number, number];
  readonly counts: readonly number[];
}

/**
 * Thrown when exporting a mask to COCO would take more runs than the export
 * allows: {@link MAX_COCO_RUNS}, or {@link MAX_COCO_ARRAY_RUNS} where the runs
 * are returned as an array.
 *
 * `MAX_COCO_RUNS` is the worst case of a full-resolution mask within the cell
 * cap, so no full-resolution mask is refused by the compressed codec. What it
 * refuses is a downsampled mask with structure finer than that: COCO has no
 * downsample, so cells are written out as image pixels, and a d=16 mask of
 * alternating cell rows needs sixteen times the runs of its cells. Below the
 * bound such a mask exports, slowly: a 6.7 kB d=16 payload of 3125 x 2500
 * alternating cells needs 125,000,001 runs, about 13 s and a 125 MB string.
 *
 * The count stops as soon as it passes the bound, so a refusal costs at most
 * the bound's worth of counting and allocates nothing.
 */
export class CocoRunLimitExceededError extends RangeError {
  /**
   * Runs counted when the count stopped: more than `maxRuns`, and not
   * necessarily the export's total (`countCocoRuns` gives that).
   */
  readonly runs: number;
  /** The most this export allows. */
  readonly maxRuns: number;
  /** The mask's downsample. */
  readonly downsample: number;

  constructor(runs: number, maxRuns: number, downsample: number, hint?: string) {
    super(
      `Exporting this mask to COCO would take more than ${maxRuns} runs (${runs} counted ` +
        `before stopping)` +
        (downsample !== 1
          ? `: COCO has no downsample, so its downsample-${downsample} cells are written out as image pixels`
          : '') +
        `. ${hint ?? 'Keep it in the canonical format, which stores the cells.'}`,
    );
    this.name = 'CocoRunLimitExceededError';
    this.runs = runs;
    this.maxRuns = maxRuns;
    this.downsample = downsample;
  }
}

/**
 * The most COCO runs any mask the format admits at full resolution can take.
 *
 * A full-resolution mask has at most one transition per pixel of its box plus
 * one per column (its entry from the pixel above), so `cells + width + 1`
 * runs; over every box within the cap that peaks at twice the cap plus one
 * (a one-row box as wide as the cap, alternating). A smaller bound — the cap
 * plus one, say — would refuse masks the brush and the schema accept.
 */
export const MAX_COCO_RUNS = 2 * DEFAULT_MAX_MASK_PIXELS + 1;

/**
 * The most runs held as an array: what `snapshotToCocoCounts` and the
 * uncompressed codec return, and what `decodeCocoCountsString` reads back.
 *
 * A JavaScript engine refuses to grow an array past a limit of its own: 2^27
 * elements in V8 from Node 24 on, but 112,813,858 by `push` in Node 21–22,
 * whose V8 is in scope since the packages declare no `engines`. This is the
 * lower of the two, so the refusal is by name, not an engine `RangeError` after
 * seconds of work. It is below {@link MAX_COCO_RUNS}, so a mask between the
 * two exports only through the compressed codec, which writes its string
 * without an array, and that string is refused by the decoder here.
 */
export const MAX_COCO_ARRAY_RUNS = Math.min(MAX_COCO_RUNS, 112_813_858);

/**
 * Where the column sweep's runs go: appended in order, alternating and
 * starting with background, touching runs of one value merged.
 */
interface CocoRunAccumulator {
  append(value: 0 | 1, length: number): void;
  /** `count` image columns that share one pattern; `column` appends one. */
  repeat(count: number, column: () => void): void;
}

/** Thrown out of a sweep by a counter whose limit was passed. */
class CocoRunLimitReached extends Error {}

/**
 * Counts the runs a sweep emits, without emitting them, and stops the sweep
 * by throwing {@link CocoRunLimitReached} the moment the count passes `limit`.
 *
 * The stop is what bounds the work. Groups of identical columns are counted
 * in closed form, but every event column walks the rows that are on, so a
 * staircase of spans whose columns all differ costs the spans squared —
 * seconds for a few tens of thousands. Each walk adds at least as many runs as
 * it visits intervals, so stopping at `limit` caps the work at about `limit`
 * plus the spans.
 */
class CocoRunCounter implements CocoRunAccumulator {
  private value: 0 | 1 = 0;
  /** Runs completed so far; the one still open is not counted. */
  completed = 0;

  constructor(private readonly limit = Infinity) {}

  append(value: 0 | 1, length: number): void {
    if (length <= 0 || value === this.value) return;
    this.completed++;
    this.value = value;
    if (this.completed >= this.limit) throw new CocoRunLimitReached();
  }

  repeat(count: number, column: () => void): void {
    if (count <= 0) return;
    column();
    if (count === 1) return;
    // Every column after the first starts in the state the one before it left,
    // so each adds what the second did: closed form, never a walk of the box.
    const before = this.completed;
    column();
    this.completed += (count - 2) * (this.completed - before);
    if (this.completed >= this.limit) throw new CocoRunLimitReached();
  }

  get total(): number {
    return this.completed + 1;
  }
}

/** Emits the runs a sweep produces, in order. */
class CocoRunEmitter implements CocoRunAccumulator {
  private value: 0 | 1 = 0;
  private length = 0;

  constructor(private readonly sink: (run: number) => void) {}

  append(value: 0 | 1, length: number): void {
    if (length <= 0) return;
    if (value === this.value) {
      this.length += length;
      return;
    }
    this.sink(this.length);
    this.value = value;
    this.length = length;
  }

  repeat(count: number, column: () => void): void {
    for (let i = 0; i < count; i++) column();
  }

  finish(): void {
    this.sink(this.length);
  }
}

/** A validated mask, ready to be swept into COCO's column-major runs. */
interface CocoSweep {
  /** The total runs for an empty mask; absent when the mask has cells. */
  readonly emptyRuns?: number[];
  readonly downsample: number;
  run(accumulator: CocoRunAccumulator): void;
}

/**
 * Prepares the transposition of a mask's row-major spans into COCO's
 * column-major runs.
 *
 * The mask is read only through {@link MaskRaster.forEachSpan}, and the spans
 * are transposed by a sweep across the columns: each span switches its row on
 * at its first column and off past its last, and between two such events every
 * column has the same runs. Fully-background columns, and the background above
 * and below the mask, are added arithmetically, so a solid region costs its
 * spans, not its box. Each column that holds an event walks the rows that are
 * on, so a mask whose spans start in many different columns costs up to the
 * spans squared, whether writing or counting: the counters stop at their
 * bound for that reason (see `countCocoRuns`).
 */
function prepareCocoSweep(input: MaskRasterInput): CocoSweep {
  const cells = input.cells;
  // Wrapping a dense snapshot checks that its data fills its box exactly.
  const raster = asMaskRaster(input);
  const { imageWidth, imageHeight } = raster;
  const { x, y, width, height } = cells;
  const total = imageWidth * imageHeight;
  const downsample = raster.downsample;
  if (width === 0 || height === 0) {
    return { emptyRuns: total > 0 ? [total] : [], downsample, run: () => {} };
  }
  assertMaskDownsample(downsample);

  // A host-built snapshot with a fractional placement would emit fractional
  // runs, which is not COCO; the canonical encoder makes the same demand.
  assertDecodableOrigin(x, y);
  assertPixelDimensions(width, height);
  // COCO runs describe the whole image, so a box poking outside it cannot be
  // expressed: the background either side would have to be negative. Silently
  // clamping would shift every column, so refuse instead.
  const grid = maskGridSize(imageWidth, imageHeight, downsample);
  assertBoxInsideImage(x, y, width, height, grid.width, grid.height);
  const box = snapshotImageBox(raster);

  // Row toggles keyed by the cell column they happen at: +1 where a span
  // starts, -1 just past where it ends. Rows are box-relative cell rows.
  const toggles = new Map<number, number[]>();
  const toggle = (col: number, row: number, delta: 1 | -1): void => {
    let list = toggles.get(col);
    if (!list) toggles.set(col, (list = []));
    list.push(delta === 1 ? row : ~row);
  };
  forEachCheckedSpan(raster, (cy, x0, x1) => {
    toggle(x0, cy - y, 1);
    toggle(x1, cy - y, -1);
  });
  const eventColumns = [...toggles.keys()].sort((a, b) => a - b);

  const run = (acc: CocoRunAccumulator): void => {
    // The rows currently on, as sorted, disjoint, non-touching [start, end)
    // intervals of box-relative cell rows.
    const active: [number, number][] = [];
    const findInterval = (row: number): number => {
      // Index of the last interval starting at or before `row`, or -1.
      let lo = 0;
      let hi = active.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (active[mid]![0] <= row) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return found;
    };
    const switchOn = (row: number): void => {
      const i = findInterval(row);
      const joinsLeft = i >= 0 && active[i]![1] === row;
      const next = active[i + 1];
      const joinsRight = next !== undefined && next[0] === row + 1;
      if (joinsLeft && joinsRight) {
        active[i]![1] = next[1];
        active.splice(i + 1, 1);
      } else if (joinsLeft) active[i]![1] = row + 1;
      else if (joinsRight) next[0] = row;
      else active.splice(i + 1, 0, [row, row + 1]);
    };
    const switchOff = (row: number): void => {
      const i = findInterval(row);
      const interval = active[i]!;
      const [start, end] = interval;
      if (start === row && end === row + 1) active.splice(i, 1);
      else if (start === row) interval[0] = row + 1;
      else if (end === row + 1) interval[1] = row;
      else {
        interval[1] = row;
        active.splice(i + 1, 0, [row + 1, end]);
      }
    };

    // One image column of the current pattern; only the image's last cell row
    // can cover fewer than `downsample` image rows.
    const emitColumn = (): void => {
      let cursor = 0;
      for (const [start, end] of active) {
        const top = (y + start) * downsample;
        const bottom = Math.min((y + end) * downsample, imageHeight);
        acc.append(0, top - cursor);
        acc.append(1, bottom - top);
        cursor = bottom;
      }
      acc.append(0, imageHeight - cursor);
    };

    acc.append(0, box.x * imageHeight);
    const boxRight = x + width;
    let col = x;
    for (let e = 0; e <= eventColumns.length; e++) {
      const next = e < eventColumns.length ? Math.min(eventColumns[e]!, boxRight) : boxRight;
      // Columns [col, next) share one pattern.
      if (next > col) {
        const left = col * downsample;
        const right = Math.min(next * downsample, imageWidth);
        const columns = right - left;
        if (active.length === 0) acc.append(0, columns * imageHeight);
        else acc.repeat(columns, emitColumn);
        col = next;
      }
      if (e === eventColumns.length || next >= boxRight) break;
      // Offs before ons: a row whose spans touch at this column stays on.
      const events = toggles.get(eventColumns[e]!)!;
      for (const event of events) if (event < 0) switchOff(~event);
      for (const event of events) if (event >= 0) switchOn(event);
    }
    acc.append(0, (imageWidth - (box.x + box.width)) * imageHeight);
  };

  return { downsample, run };
}

/**
 * Exactly how many runs a mask's COCO export takes, without producing them.
 *
 * Groups of identical columns are counted in closed form, so a solid region
 * costs its spans, not its box. A mask whose spans start in many different
 * columns costs more — up to the spans squared, which can be a fixed fraction
 * of the box — and nothing here stops early; the exporters do, at their bound.
 */
export function countCocoRuns(input: MaskRasterInput): number {
  const sweep = prepareCocoSweep(input);
  if (sweep.emptyRuns) return sweep.emptyRuns.length;
  const counter = new CocoRunCounter();
  sweep.run(counter);
  return counter.total;
}

/**
 * The sweep for a mask and its exact run total, refused with
 * {@link CocoRunLimitExceededError} if its export would take more than
 * {@link MAX_COCO_RUNS} runs. The count stops as soon as it passes, so a
 * refusal never costs more than the bound's worth of counting.
 */
function boundedCocoSweep(input: MaskRasterInput): { sweep: CocoSweep; total: number } {
  const sweep = prepareCocoSweep(input);
  if (sweep.emptyRuns) return { sweep, total: sweep.emptyRuns.length };
  // The total is the completed runs plus the one still open, so the export
  // is over the bound once `MAX_COCO_RUNS` runs have completed.
  const counter = new CocoRunCounter(MAX_COCO_RUNS);
  try {
    sweep.run(counter);
  } catch (error) {
    if (!(error instanceof CocoRunLimitReached)) throw error;
    throw new CocoRunLimitExceededError(counter.total, MAX_COCO_RUNS, sweep.downsample);
  }
  return { sweep, total: counter.total };
}

/**
 * Converts a mask to COCO run lengths: **column-major** over the full image,
 * alternating and starting with background.
 *
 * COCO has no notion of a downsample — its runs are image pixels — so a
 * downsampled mask is exported as the level-0 mask it means, every cell
 * expanded to the image pixels it covers, without materialising level 0. An
 * export that would take more than {@link MAX_COCO_ARRAY_RUNS} runs is
 * refused first, with {@link CocoRunLimitExceededError}: the runs are an
 * array, and an engine cannot hold more. The compressed codec's string has no
 * such limit, and is bounded at {@link MAX_COCO_RUNS} instead.
 */
export function snapshotToCocoCounts(input: MaskRasterInput): number[] {
  const { sweep, total } = boundedCocoSweep(input);
  if (total > MAX_COCO_ARRAY_RUNS) {
    throw new CocoRunLimitExceededError(
      total,
      MAX_COCO_ARRAY_RUNS,
      sweep.downsample,
      'Export it with the compressed COCO codec, whose counts string has no array limit.',
    );
  }
  if (sweep.emptyRuns) return sweep.emptyRuns;
  const runs: number[] = [];
  const emitter = new CocoRunEmitter((run) => runs.push(run));
  sweep.run(emitter);
  emitter.finish();
  return runs;
}

/** Rebuilds a tightly-cropped snapshot from COCO column-major run lengths. */
export function cocoCountsToSnapshot(
  counts: readonly number[],
  imageHeight: number,
  imageWidth: number,
  options?: MaskDecodeOptions,
): MaskSnapshot {
  // Counts describe the whole image, so they must sum to exactly its area.
  // Rejecting here keeps a malformed payload from driving an unbounded loop.
  // `imageHeight` divides indices into rows below; a fractional value makes
  // every derived row fractional, which silently drops pixels instead of
  // failing. Reject before any of that runs.
  assertCountableImage(imageWidth, imageHeight);
  // A number, a boolean or an object has no runs to iterate and would decode
  // as the empty mask, admitted with nothing in `skipped`.
  if (!Array.isArray(counts)) {
    throw new RangeError(`COCO counts must be an array of run lengths, got ${typeof counts}`);
  }

  let total = 0;
  for (const run of counts) {
    // A fractional run fills a fractional range and the bbox arithmetic then
    // reports it as a fractional dimension; refuse it as what it is.
    if (!Number.isInteger(run) || run < 0) {
      throw new RangeError(`COCO run lengths must be non-negative integers, got ${run}`);
    }
    total += run;
  }
  // The runs cover the whole image, so they sum to exactly its area; the empty
  // mask is a single run of the whole image, not no runs at all.
  const area = imageWidth * imageHeight;
  if (total !== area) {
    throw new RangeError(`COCO counts sum to ${total}, but the image has ${area} pixels`);
  }

  // At a declared downsample the runs go straight into cells, in work
  // proportional to the runs and the cells, not to the pixels covered.
  const downsample = options?.downsample ?? 1;
  assertMaskDownsample(downsample);
  if (downsample !== 1) {
    return cocoCountsToCells(counts, imageHeight, imageWidth, downsample, options?.maxPixels);
  }

  // Bound the work before doing any. The scans below are O(foreground pixels),
  // and `area` comes from the payload's own `size` — so a hostile document
  // declaring a gigapixel image with one full-image run would otherwise spin
  // for hours before the allocation guard further down ever ran.
  //
  // The foreground count is what the scans actually walk, so that is what is
  // capped; a huge image holding a small mask stays decodable.
  let foreground = 0;
  for (let i = 1; i < counts.length; i += 2) foreground += counts[i]!;
  assertDecodableCount(foreground, options?.maxPixels);

  const bounds = cocoForegroundBounds(counts, imageHeight);
  if (!bounds) return emptySnapshot(imageWidth, imageHeight);
  const { minCol, minRow } = bounds;

  const width = bounds.maxCol - minCol + 1;
  const height = bounds.maxRow - minRow + 1;
  // Only the bounding box is materialised, so that — not the image area — is
  // what has to fit. A tiny mask on a gigapixel canvas is perfectly decodable.
  assertDecodableArea(width, height, options?.maxPixels);
  const data = new Uint8Array(width * height);
  {
    let index = 0;
    let value: 0 | 1 = 0;
    for (const run of counts) {
      if (value === 1) {
        // Counted, not compared: `i < index + run` relies on `i++` advancing,
        // which stops being true once the index passes the exact-integer range.
        // `assertCountableImage` rules that out, and counting makes the loop
        // structurally finite regardless.
        let i = index;
        for (let remaining = run; remaining > 0; remaining--, i++) {
          data[((i % imageHeight) - minRow) * width + (Math.floor(i / imageHeight) - minCol)] = 1;
        }
      }
      index += run;
      value = value === 1 ? 0 : 1;
    }
  }

  return {
    cells: { x: minCol, y: minRow, width, height },
    data,
    imageWidth,
    imageHeight,
    downsample: 1,
  };
}

/**
 * The foreground's bounding box in image pixels, or `null` for an empty mask.
 *
 * Taken from run *boundaries*, not from visiting each foreground pixel: a run
 * occupies a contiguous span of the column-major index, so its extent follows
 * from its endpoints. That makes this pass O(runs) instead of O(foreground
 * pixels) — for a full-image mask, two divisions instead of a billion
 * iterations — so the capacity check after it is reached immediately rather
 * than after the scan it is meant to prevent.
 */
function cocoForegroundBounds(
  counts: readonly number[],
  imageHeight: number,
): { minCol: number; maxCol: number; minRow: number; maxRow: number } | null {
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  let index = 0;
  let value: 0 | 1 = 0;
  for (const run of counts) {
    if (value === 1 && run > 0) {
      const firstCol = Math.floor(index / imageHeight);
      const lastCol = Math.floor((index + run - 1) / imageHeight);
      if (firstCol < minCol) minCol = firstCol;
      if (lastCol > maxCol) maxCol = lastCol;
      if (firstCol === lastCol) {
        // Wholly inside one column: rows are just the run's own extent.
        const firstRow = index % imageHeight;
        const lastRow = (index + run - 1) % imageHeight;
        if (firstRow < minRow) minRow = firstRow;
        if (lastRow > maxRow) maxRow = lastRow;
      } else {
        // It spans a column boundary, so it reaches the bottom of one column
        // and the top of the next — which is every row, whether it crosses
        // one boundary or many.
        minRow = 0;
        maxRow = imageHeight - 1;
      }
    }
    index += run;
    value = value === 1 ? 0 : 1;
  }
  return maxCol < 0 || !Number.isFinite(minCol) ? null : { minCol, maxCol, minRow, maxRow };
}

/**
 * Decodes COCO runs straight into cells at `downsample`, refusing a payload
 * that is not constant within each cell (clipped at the image's edges) rather
 * than decoding it at downsample 1 or rounding it.
 *
 * The runs are read as a sequence of image columns, each a list of
 * foreground segments, with consecutive identical columns grouped. A cell
 * column is then valid when every image column in it has the same segments
 * and every segment starts and ends on a cell boundary (or the image's
 * bottom). The work is proportional to the runs and to the cells written,
 * never to the image pixels the mask covers: a 21,024 x 17,024-pixel region
 * at downsample 16 is 1,314 x 1,064 cells.
 */
function cocoCountsToCells(
  counts: readonly number[],
  imageHeight: number,
  imageWidth: number,
  downsample: number,
  maxPixels: number | undefined,
): MaskSnapshot {
  const d = downsample;
  const bounds = cocoForegroundBounds(counts, imageHeight);
  if (!bounds) return { ...emptySnapshot(imageWidth, imageHeight), downsample: d };
  const cx0 = Math.floor(bounds.minCol / d);
  const cy0 = Math.floor(bounds.minRow / d);
  const width = Math.floor(bounds.maxCol / d) - cx0 + 1;
  const height = Math.floor(bounds.maxRow / d) - cy0 + 1;
  // In cells: that is what is allocated.
  assertDecodableArea(width, height, maxPixels, d);
  const data = new Uint8Array(width * height);

  const refuse = (): never => {
    throw new RangeError(
      `COCO mask is not constant within each ${d}x${d} block, so it cannot be stored at ` +
        `downsample ${d}`,
    );
  };
  const sameSegments = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // The cell column being checked, and the segments its first image column had.
  let refColumn = -1;
  let refSegments: readonly number[] = [];
  const write = (cx: number, segments: readonly number[]): void => {
    for (let s = 0; s < segments.length; s += 2) {
      const top = segments[s]!;
      const bottom = segments[s + 1]!;
      if (top % d !== 0 || (bottom % d !== 0 && bottom !== imageHeight)) refuse();
      for (let cy = top / d; cy < Math.ceil(bottom / d); cy++) {
        data[(cy - cy0) * width + (cx - cx0)] = 1;
      }
    }
  };
  /** `count` image columns from `first`, each with `segments` ([top, bottom) pairs). */
  const columns = (first: number, count: number, segments: readonly number[]): void => {
    let col = first;
    const end = first + count;
    while (col < end) {
      const cx = Math.floor(col / d);
      const cellEnd = Math.min((cx + 1) * d, imageWidth);
      if (cx !== refColumn) {
        refColumn = cx;
        refSegments = segments;
        write(cx, segments);
      } else if (!sameSegments(segments, refSegments)) refuse();
      if (segments.length === 0 && end - col > 2 * d) {
        // A stretch of empty columns: skip to the cell column it ends in,
        // setting each whole cell column it covers to empty in one step.
        const lastCx = Math.floor((end - 1) / d);
        if (lastCx > cx) {
          refColumn = lastCx;
          refSegments = segments;
          col = lastCx * d;
          continue;
        }
      }
      col = Math.min(end, cellEnd);
    }
  };

  // Walk the runs as image columns of segments.
  let column = 0;
  let segments: number[] = [];
  const flush = (upTo: number): void => {
    // Ends the current column and emits empty ones until `upTo`.
    columns(column, 1, segments);
    segments = [];
    column++;
    if (upTo > column) columns(column, upTo - column, []);
    column = Math.max(column, upTo);
  };
  let index = 0;
  let value: 0 | 1 = 0;
  for (const run of counts) {
    if (value === 1 && run > 0) {
      let start = index;
      const stop = index + run;
      while (start < stop) {
        const col = Math.floor(start / imageHeight);
        if (col !== column) flush(col);
        const row = start - col * imageHeight;
        if (row === 0 && stop - start >= imageHeight) {
          // Whole columns, emitted as one group.
          const whole = Math.floor((stop - start) / imageHeight);
          if (segments.length > 0) flush(col);
          columns(col, whole, [0, imageHeight]);
          column = col + whole;
          start += whole * imageHeight;
          continue;
        }
        const segmentEnd = Math.min(stop, (col + 1) * imageHeight);
        const top = row;
        const bottom = segmentEnd - col * imageHeight;
        if (segments.length > 0 && segments[segments.length - 1] === top) {
          segments[segments.length - 1] = bottom;
        } else segments.push(top, bottom);
        start = segmentEnd;
      }
    }
    index += run;
    value = value === 1 ? 0 : 1;
  }
  if (column < imageWidth) flush(imageWidth);

  return {
    cells: { x: cx0, y: cy0, width, height },
    data,
    imageWidth,
    imageHeight,
    downsample: d,
  };
}

/**
 * pycocotools' `rleToString`, one count at a time: each count (delta-coded
 * against two positions back, after the first two) is emitted in 5-bit chunks,
 * bit `0x20` marking continuation and bit `0x10` carrying sign, offset by 48
 * into printable ASCII.
 *
 * Arithmetic is done with division rather than bit operators because a
 * background run on a gigapixel image easily exceeds the 32 bits that
 * JavaScript's bitwise operators coerce to. Characters are buffered and joined
 * in blocks, so a mask of tens of millions of runs never builds an array of
 * them.
 */
class CocoCountsStringWriter {
  private index = 0;
  private previous = 0;
  private beforePrevious = 0;
  private readonly buffer = new Uint8Array(16_384);
  private used = 0;
  private readonly parts: string[] = [];

  push(count: number): void {
    let value = this.index > 2 ? count - this.beforePrevious : count;
    this.beforePrevious = this.previous;
    this.previous = count;
    this.index++;
    let more = true;
    while (more) {
      let chunk = ((value % 32) + 32) % 32;
      value = Math.floor(value / 32);
      more = (chunk & 0x10) !== 0 ? value !== -1 : value !== 0;
      if (more) chunk |= 0x20;
      if (this.used === this.buffer.length) this.flush();
      this.buffer[this.used++] = chunk + 48;
    }
  }

  finish(): string {
    this.flush();
    return this.parts.join('');
  }

  private flush(): void {
    if (this.used === 0) return;
    this.parts.push(String.fromCharCode(...this.buffer.subarray(0, this.used)));
    this.used = 0;
  }
}

/** pycocotools' `rleToString` over a list of counts. */
export function encodeCocoCountsString(counts: readonly number[]): string {
  const writer = new CocoCountsStringWriter();
  for (const count of counts) writer.push(count);
  return writer.finish();
}

/**
 * A mask's COCO counts string, written straight from the sweep: no array of
 * runs exists at any point. Refused past {@link MAX_COCO_RUNS} runs.
 */
function cocoCountsStringOf(input: MaskRasterInput): string {
  const { sweep } = boundedCocoSweep(input);
  if (sweep.emptyRuns) return encodeCocoCountsString(sweep.emptyRuns);
  const writer = new CocoCountsStringWriter();
  const emitter = new CocoRunEmitter((run) => writer.push(run));
  sweep.run(emitter);
  emitter.finish();
  return writer.finish();
}

/**
 * Inverse of {@link encodeCocoCountsString}.
 *
 * COCO counts strings travel through JSON files written by other tools, so the
 * input is treated as untrusted: a character outside the 6-bit alphabet, a
 * value too large to represent exactly, a stream that ends mid-value, or a
 * delta that resolves to a negative run all mean the payload is not a valid
 * encoding. Each is rejected rather than decoded into a mask that looks
 * plausible but is wrong.
 */
export function decodeCocoCountsString(encoded: string): number[] {
  // A non-string has no `length` to walk and would decode as no runs at all.
  if (typeof encoded !== 'string') {
    throw new RangeError(`COCO counts must be a string, got ${typeof encoded}`);
  }
  const counts: number[] = [];
  let position = 0;
  while (position < encoded.length) {
    if (counts.length >= MAX_COCO_ARRAY_RUNS) {
      throw new RangeError(
        `COCO counts string holds more than ${MAX_COCO_ARRAY_RUNS} runs ` +
          `(MAX_COCO_ARRAY_RUNS), more than an engine holds in one array`,
      );
    }
    let value = 0;
    let shift = 0;
    let more = true;
    while (more) {
      if (position >= encoded.length) {
        throw new RangeError('COCO counts string ended mid-value');
      }
      const chunk = encoded.charCodeAt(position) - 48;
      position++;
      if (chunk < 0 || chunk > 0x3f) {
        throw new RangeError(
          `COCO counts string holds a character outside its alphabet at index ${position - 1}`,
        );
      }
      if (shift > MAX_COCO_CHUNKS) {
        throw new RangeError('COCO run length exceeds the safe integer range');
      }
      more = (chunk & 0x20) !== 0;
      // The final chunk carries the sign: fold it into that chunk's own term.
      // Adding the chunk unsigned and subtracting 2^(5k) after made an
      // intermediate sum near 2^55 for an 11-chunk negative delta, past exact
      // integers, and its low bits rounded away.
      const digit = (chunk & 0x1f) - (!more && (chunk & 0x10) !== 0 ? 32 : 0);
      value += digit * Math.pow(2, 5 * shift);
      shift++;
    }
    if (counts.length > 2) value += counts[counts.length - 2]!;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`COCO counts string decodes to an invalid run length: ${value}`);
    }
    counts.push(value);
  }
  return counts;
}

/** Beyond this a 5-bit chunked count can no longer be represented exactly. */
const MAX_COCO_CHUNKS = 10;

/**
 * Largest image area every mask of which `pycocotools` reads back correctly.
 *
 * Three limits in the reference implementation's C code make larger images
 * unsafe for some masks:
 *
 * - It stores run lengths in 32-bit unsigned integers, so a run longer than
 *   `0xffffffff` is truncated.
 * - It reads each delta (`counts[i] - counts[i - 2]`) in 5-bit chunks into an
 *   `int`, and sign-extends the last one with a shift of five bits per chunk.
 *   A delta below -2^29 takes seven chunks, a shift past the integer's width,
 *   and is misread — and so is every count after it. A huge background gap
 *   followed two runs later by a short one is enough: three pixels on a
 *   24,000 x 24,000 image come back with the right area and the wrong box.
 * - Its `rleToBbox` accumulates the column-major position, and `rleArea` the
 *   area, in a 32-bit `uint`, so a foreground pixel at index 2^32 or past it
 *   gets a wrong box, and a large mask a wrong area. Any image of more than
 *   2^32 pixels can reach it.
 *
 * Within this area no run can exceed 2^29, no delta can fall below -2^29 and
 * no position can reach 2^32, so every mask is safe. Beyond it, whether a mask is safe depends on its
 * runs: ask {@link isCocoInteropSafe}. Our own encoder and decoder handle every
 * case correctly; nothing in this package enforces this bound.
 */
export const COCO_MAX_INTEROP_IMAGE_PIXELS = 2 ** 29;

/** The most negative delta `pycocotools` reads back correctly: seven chunks are misread. */
const COCO_MIN_INTEROP_DELTA = -(2 ** 29);
/** The longest run `pycocotools` stores without truncating it. */
const COCO_MAX_INTEROP_RUN = 0xffffffff;
/**
 * The first column-major pixel index `pycocotools` cannot place: `rleToBbox`
 * accumulates the position, and `rleArea` the area, in a 32-bit `uint`.
 */
const COCO_MAX_INTEROP_POSITION = 2 ** 32;

/**
 * Whether `pycocotools` reads this mask's COCO encoding back correctly. Three
 * of its 32-bit limits apply (see {@link COCO_MAX_INTEROP_IMAGE_PIXELS}):
 *
 * - every run must fit its 32-bit store;
 * - every delta it decodes must be at least -2^29;
 * - no foreground pixel may lie at column-major index 2^32 or beyond, since
 *   `rleToBbox` accumulates the position, and `rleArea` the area, in a `uint`.
 *   Past it the box is wrong, and on a large mask the area too: a one-pixel
 *   line across a 100,000 x 80,000 image comes back as a 53,687 x 7,297 box.
 *
 * Verified against pycocotools 2.0.11. Decided from the mask's own runs, by a
 * sweep that stops at the first one out of range, or at
 * {@link MAX_COCO_RUNS} runs: a mask past that is not exported at all, so it
 * is not safe either, and the bound keeps the answer as cheap as the
 * exporter's refusal. An image within `COCO_MAX_INTEROP_IMAGE_PIXELS` is
 * answered without a sweep, since every limit holds there; that answer is
 * about pycocotools only, not whether the export fits its run bound. Worth
 * checking before exporting masks from very large (deep-zoom) images,
 * because the failure is silent.
 */
export function isCocoInteropSafe(input: MaskRasterInput): boolean {
  if (input.imageWidth * input.imageHeight <= COCO_MAX_INTEROP_IMAGE_PIXELS) return true;
  const sweep = prepareCocoSweep(input);
  // An empty mask's runs have no foreground to place.
  if (sweep.emptyRuns) return sweep.emptyRuns.every((run) => run <= COCO_MAX_INTEROP_RUN);
  // The last two runs are all a delta needs, and the running position is all
  // the box and area need; stop at the first violation, or at the run bound.
  let index = 0;
  let previous = 0;
  let beforePrevious = 0;
  let position = 0;
  let safe = true;
  const unsafe = new CocoRunLimitReached();
  const emitter = new CocoRunEmitter((run) => {
    position += run;
    if (
      run > COCO_MAX_INTEROP_RUN ||
      (index > 2 && run - beforePrevious < COCO_MIN_INTEROP_DELTA) ||
      // A foreground run (odd index) whose last pixel is at 2^32 or past it.
      (index % 2 === 1 && position > COCO_MAX_INTEROP_POSITION) ||
      index >= MAX_COCO_RUNS
    ) {
      safe = false;
      throw unsafe;
    }
    beforePrevious = previous;
    previous = run;
    index++;
  });
  try {
    sweep.run(emitter);
    emitter.finish();
  } catch (error) {
    if (error !== unsafe) throw error;
  }
  return safe;
}

/**
 * Reads `size` off a payload that may not be one: a missing or malformed
 * `size` otherwise surfaces as a bare `TypeError` from the destructuring.
 */
function cocoSize(payload: { readonly size?: unknown }): readonly [number, number] {
  const size = payload.size;
  if (!Array.isArray(size) || size.length !== 2) {
    throw new RangeError('COCO size must be [height, width]');
  }
  return [size[0] as number, size[1] as number];
}

/**
 * COCO `bbox`: `[x, y, width, height]` of the mask's bounding box, in image
 * pixels at every downsample.
 */
export function cocoBbox(snapshot: MaskBoxFields): [number, number, number, number] {
  const box = snapshotImageBox(snapshot);
  return [box.x, box.y, box.width, box.height];
}

/** COCO `area`: the exact count of foreground image pixels, at every downsample. */
export function cocoArea(snapshot: MaskRasterInput): number {
  return snapshotPixelCount(snapshot);
}

/**
 * Canonical COCO RLE — what `pycocotools` emits and consumes.
 *
 * Verified against the reference implementation: for the fixtures in
 * `tests/fixtures/pycocotools-golden.json`, `pycocotools.mask.encode` produces
 * byte-identical counts to this codec, and its `decode` returns pixel-identical
 * masks.
 *
 * **Limitations in `pycocotools`, not here.** It truncates runs longer than
 * 32 bits and misreads deltas below -2^29 when it reads a mask back, so on an
 * image larger than {@link COCO_MAX_INTEROP_IMAGE_PIXELS} some masks come back
 * with the right area in the wrong place.
 *
 * This codec encodes and decodes such runs correctly and deliberately does
 * **not** refuse, clamp, or warn about them — the output is valid COCO, and
 * imposing a limit here would be wrong for consumers whose tooling reads wide
 * counts. Callers who care can check {@link isCocoInteropSafe} themselves; it
 * is offered as a utility and never applied automatically.
 */
export const cocoRleCodec: MaskCodec<CocoRleSegmentation> = {
  format: COCO_RLE_FORMAT,
  encodesDownsampled: true,
  encode(snapshot) {
    return {
      size: [snapshot.imageHeight, snapshot.imageWidth],
      counts: cocoCountsStringOf(snapshot),
    };
  },
  decode(payload, options) {
    const [height, width] = cocoSize(payload);
    return denseRaster(
      cocoCountsToSnapshot(decodeCocoCountsString(payload.counts), height, width, options),
    );
  },
};

/** COCO RLE with plain integer counts — easier to inspect, same ordering. */
export const cocoRleUncompressedCodec: MaskCodec<CocoRleUncompressedSegmentation> = {
  format: COCO_RLE_UNCOMPRESSED_FORMAT,
  encodesDownsampled: true,
  encode(snapshot) {
    return {
      size: [snapshot.imageHeight, snapshot.imageWidth],
      counts: snapshotToCocoCounts(snapshot),
    };
  },
  decode(payload, options) {
    const [height, width] = cocoSize(payload);
    return denseRaster(cocoCountsToSnapshot(payload.counts, height, width, options));
  },
};
