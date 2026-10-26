import {
  MaskCapacityExceededError,
  emptySnapshot,
  type MaskBuffer,
  type MaskCellBox,
  type MaskRegion,
  type MaskSnapshot,
} from './mask-buffer.js';
import {
  assertBoxInsideImage,
  assertDecodableArea,
  assertDecodableOrigin,
} from './decode-guard.js';
import type { MaskDecodeOptions } from './mask-codec.js';
import { assertMaskDownsample, maskGridSize } from './downsample.js';
import {
  asMaskRaster,
  denseRaster,
  forEachCheckedSpan,
  type MaskRaster,
  type MaskRasterInput,
} from './mask-raster.js';

/**
 * Allocation is rounded outward to a multiple of this so that repeated strokes
 * near an edge do not reallocate on every pixel.
 */
const GROWTH_CHUNK = 64;

function toDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${value}`);
  }
  return Math.floor(value);
}

/** Default cap on allocated pixels (~64 megapixels ≈ 64 MB at one byte each). */
export const DEFAULT_MAX_MASK_PIXELS = 64 * 1024 * 1024;

export interface BoundedDenseMaskBufferOptions {
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Maximum allocated cells before {@link MaskCapacityExceededError}. */
  readonly maxPixels?: number | undefined;
  /**
   * Image pixels per cell along each axis: a power of two, default 1. The
   * buffer then addresses the image's `ceil(side / downsample)` cell grid, and
   * the cap counts cells, so a coarser grid reaches further across the image
   * for the same memory.
   */
  readonly downsample?: number | undefined;
}

/**
 * A dense mask buffer covering only the painted region, growing on demand.
 *
 * This is the model CVAT and 3D Slicer converged on — CVAT stores each mask
 * cropped to its bounding box, and Slicer keeps a per-segment extent plus an
 * offset — and it is what makes painting on very large (deep-zoom) images
 * affordable: cost scales with the area you actually paint, not the image.
 *
 * The allocated region is always a superset of the set pixels; `snapshot()`
 * crops to the exact bounding box.
 */
export class BoundedDenseMaskBuffer implements MaskBuffer {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly downsample: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  private readonly maxPixels: number;

  /** Allocated region (a superset of the set pixels). */
  private ax = 0;
  private ay = 0;
  private aw = 0;
  private ah = 0;
  private data = new Uint8Array(0);
  private count = 0;

  constructor(options: BoundedDenseMaskBufferOptions) {
    // Math.floor(NaN) is NaN, which would slip past every subsequent bounds
    // check and silently disable the capacity cap, so reject it outright.
    this.imageWidth = toDimension(options.imageWidth, 'imageWidth');
    this.imageHeight = toDimension(options.imageHeight, 'imageHeight');
    const maxPixels = options.maxPixels ?? DEFAULT_MAX_MASK_PIXELS;
    if (!Number.isFinite(maxPixels) || maxPixels <= 0) {
      throw new RangeError(`maxPixels must be a positive finite number, got ${maxPixels}`);
    }
    this.maxPixels = maxPixels;
    const downsample = options.downsample ?? 1;
    assertMaskDownsample(downsample);
    this.downsample = downsample;
    const grid = maskGridSize(this.imageWidth, this.imageHeight, downsample);
    this.gridWidth = grid.width;
    this.gridHeight = grid.height;
  }

  /**
   * Rebuilds a buffer from a mask (e.g. after loading a saved annotation):
   * any {@link MaskRaster}, or a dense snapshot a host built.
   */
  static fromSnapshot(input: MaskRasterInput, options?: MaskDecodeOptions): BoundedDenseMaskBuffer {
    const raster = asMaskRaster(input);
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: raster.imageWidth,
      imageHeight: raster.imageHeight,
      ...(options?.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
      downsample: raster.downsample,
    });
    if (raster.cells.width > 0 && raster.cells.height > 0) buffer.blit(raster);
    return buffer;
  }

  /**
   * Copies a raster into this (still empty) buffer: reserve once, then fill
   * span by span.
   *
   * Going through `set()` per pixel instead cost a bounds check, a growth
   * check, and a call per pixel — enough to stall the first frame of every
   * stroke that refines an existing mask.
   */
  private blit(raster: MaskRaster): void {
    // `set()` screens fractional coordinates one at a time; a bulk copy has to
    // do it once, up front. Skipping it was worse than the per-pixel path it
    // replaced: fractional indices write nowhere while `count` still advances,
    // leaving the buffer permanently claiming pixels it does not have.
    const box = raster.cells;
    assertDecodableOrigin(box.x, box.y);
    // The dense cap is this buffer's own policy: it is what this
    // implementation allocates, not a property of the mask.
    assertDecodableArea(box.width, box.height, this.maxPixels);
    // Every in-tree caller arrives via a decoder, which already checked this.
    // A host handing us a snapshot it built itself — a model's output, say —
    // does not, and `reserve` clips the overhang away: the mask would come
    // back quietly truncated on its first refining stroke, which is the
    // failure this guard exists to prevent everywhere else.
    assertBoxInsideImage(box.x, box.y, box.width, box.height, this.gridWidth, this.gridHeight);

    this.reserve(box);

    // Only called on a fresh buffer, so every cell starts at 0 and each span
    // adds exactly its length. reserve() clips to the image, so a span poking
    // outside it is written only where it overlaps.
    forEachCheckedSpan(raster, (cy, x0, x1) => {
      const row = cy - this.ay;
      if (row < 0 || row >= this.ah) return;
      const left = Math.max(x0, this.ax);
      const right = Math.min(x1, this.ax + this.aw);
      if (right <= left) return;
      const offset = row * this.aw - this.ax;
      this.data.fill(1, offset + left, offset + right);
      this.count += right - left;
    });
  }

  get cellCount(): number {
    return this.count;
  }

  /** The currently allocated cells — a superset of the set cells. */
  get cellBounds(): MaskCellBox {
    return { x: this.ax, y: this.ay, width: this.aw, height: this.ah };
  }

  get(x: number, y: number): 0 | 1 {
    const col = x - this.ax;
    const row = y - this.ay;
    if (col < 0 || row < 0 || col >= this.aw || row >= this.ah) return 0;
    return this.data[row * this.aw + col] === 1 ? 1 : 0;
  }

  set(x: number, y: number, value: 0 | 1): void {
    // Coordinates index a typed array, so a fractional or NaN value would write
    // nowhere while still moving cellCount — leaving the buffer claiming
    // pixels it does not have, and snapshot() reporting negative dimensions.
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || y < 0 || x >= this.gridWidth || y >= this.gridHeight) return;

    let col = x - this.ax;
    let row = y - this.ay;
    const outside = col < 0 || row < 0 || col >= this.aw || row >= this.ah;

    if (outside) {
      // Nothing to erase outside the allocated region.
      if (value === 0) return;
      this.grow(x, y);
      col = x - this.ax;
      row = y - this.ay;
    }

    const index = row * this.aw + col;
    const previous = this.data[index]!;
    if (previous === value) return;
    this.data[index] = value;
    this.count += value === 1 ? 1 : -1;
  }

  /** The current cells as a {@link MaskRaster}: a dense, tightly-cropped copy. */
  raster(): MaskRaster {
    return denseRaster(this.snapshot());
  }

  /**
   * Produces a tightly-cropped, copied dense snapshot of the current cells.
   * Specific to this implementation; the {@link MaskBuffer} contract is
   * {@link BoundedDenseMaskBuffer.raster}.
   */
  snapshot(): MaskSnapshot {
    if (this.count === 0) return emptySnapshot(this.imageWidth, this.imageHeight);

    // Tight bounding box of set pixels within the allocated region.
    //
    // This scans the whole region rather than narrowing to a box tracked during
    // painting: maintaining such a box costs four comparisons per painted pixel
    // — about 10% of the brush's per-frame budget — to save a few milliseconds
    // once per stroke, on the pointer-up path that dispatches and re-renders
    // anyway. The 60fps path wins.
    let minCol = this.aw;
    let minRow = this.ah;
    let maxCol = -1;
    let maxRow = -1;
    for (let row = 0; row < this.ah; row++) {
      const rowOffset = row * this.aw;
      for (let col = 0; col < this.aw; col++) {
        if (this.data[rowOffset + col] === 1) {
          if (col < minCol) minCol = col;
          if (col > maxCol) maxCol = col;
          if (row < minRow) minRow = row;
          if (row > maxRow) maxRow = row;
        }
      }
    }

    // Belt-and-braces: if count disagreed with the stored pixels we would fall
    // through with the sentinels intact and emit a negative-sized snapshot.
    if (maxCol < 0 || maxRow < 0) return emptySnapshot(this.imageWidth, this.imageHeight);

    const width = maxCol - minCol + 1;
    const height = maxRow - minRow + 1;
    const cropped = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      const src = (minRow + row) * this.aw + minCol;
      cropped.set(this.data.subarray(src, src + width), row * width);
    }

    return {
      cells: { x: this.ax + minCol, y: this.ay + minRow, width, height },
      data: cropped,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      downsample: this.downsample,
    };
  }

  /**
   * Expands the allocated region to cover `region`, preserving existing pixels.
   *
   * Growing once for a whole disc or stroke segment matters: a radius-500 stamp
   * on a fresh buffer crosses `GROWTH_CHUNK` boundaries dozens of times,
   * and letting `set` discover each one reallocates and re-blits every time.
   * It also makes the stamp atomic — the cap is checked before any pixel moves.
   */
  reserve(region: MaskRegion): void {
    // A non-finite bound would survive every comparison below and land as NaN
    // in the allocated origin, quietly bricking the buffer.
    if (
      !Number.isFinite(region.x) ||
      !Number.isFinite(region.y) ||
      !Number.isFinite(region.width) ||
      !Number.isFinite(region.height)
    ) {
      return;
    }
    const left = Math.max(0, Math.floor(region.x));
    const top = Math.max(0, Math.floor(region.y));
    const right = Math.min(this.gridWidth, Math.ceil(region.x + region.width));
    const bottom = Math.min(this.gridHeight, Math.ceil(region.y + region.height));
    if (right <= left || bottom <= top) return;
    if (
      this.aw > 0 &&
      this.ah > 0 &&
      left >= this.ax &&
      top >= this.ay &&
      right <= this.ax + this.aw &&
      bottom <= this.ay + this.ah
    ) {
      return;
    }
    this.grow(left, top, right - 1, bottom - 1);
  }

  /** Expands the allocated region to include (x, y), preserving existing pixels. */
  private grow(x: number, y: number, x2: number = x, y2: number = y): void {
    const hasRegion = this.aw > 0 && this.ah > 0;
    const minX = hasRegion ? Math.min(this.ax, x) : x;
    const minY = hasRegion ? Math.min(this.ay, y) : y;
    const maxX = hasRegion ? Math.max(this.ax + this.aw - 1, x2) : x2;
    const maxY = hasRegion ? Math.max(this.ay + this.ah - 1, y2) : y2;

    let nx = Math.max(0, Math.floor(minX / GROWTH_CHUNK) * GROWTH_CHUNK);
    let ny = Math.max(0, Math.floor(minY / GROWTH_CHUNK) * GROWTH_CHUNK);
    let nRight = Math.min(this.gridWidth, Math.ceil((maxX + 1) / GROWTH_CHUNK) * GROWTH_CHUNK);
    let nBottom = Math.min(this.gridHeight, Math.ceil((maxY + 1) / GROWTH_CHUNK) * GROWTH_CHUNK);

    // The chunk rounding is a convenience, not a demand: when it alone would
    // overrun the cap, settle for exactly the region asked for. Otherwise a
    // mask that decodes under the cap — the decoder bounds the box, not the
    // allocation — renders but refuses the first stroke that refines it.
    if ((nRight - nx) * (nBottom - ny) > this.maxPixels) {
      nx = minX;
      ny = minY;
      nRight = maxX + 1;
      nBottom = maxY + 1;
    }
    const nw = nRight - nx;
    const nh = nBottom - ny;

    const requested = nw * nh;
    if (requested > this.maxPixels) throw new MaskCapacityExceededError(requested, this.maxPixels);

    const next = new Uint8Array(requested);
    if (hasRegion) {
      const colOffset = this.ax - nx;
      const rowOffset = this.ay - ny;
      for (let row = 0; row < this.ah; row++) {
        const src = row * this.aw;
        next.set(this.data.subarray(src, src + this.aw), (row + rowOffset) * nw + colOffset);
      }
    }

    this.ax = nx;
    this.ay = ny;
    this.aw = nw;
    this.ah = nh;
    this.data = next;
  }
}
