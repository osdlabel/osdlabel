import {
  MaskCapacityExceededError,
  emptySnapshot,
  type MaskBuffer,
  type MaskRegion,
  type MaskSnapshot,
} from './mask-buffer.js';
import {
  assertBoxInsideImage,
  assertDecodableArea,
  assertDecodableOrigin,
} from './decode-guard.js';
import type { MaskDecodeOptions } from './mask-codec.js';

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
  /** Maximum allocated pixels before {@link MaskCapacityExceededError}. */
  readonly maxPixels?: number | undefined;
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
  }

  /** Rebuilds a buffer from a snapshot (e.g. after loading a saved annotation). */
  static fromSnapshot(snapshot: MaskSnapshot, options?: MaskDecodeOptions): BoundedDenseMaskBuffer {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: snapshot.imageWidth,
      imageHeight: snapshot.imageHeight,
      ...(options?.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
    });
    if (snapshot.width > 0 && snapshot.height > 0) buffer.blit(snapshot);
    return buffer;
  }

  /**
   * Copies a snapshot in wholesale: reserve once, then write row by row.
   *
   * Going through `set()` per pixel instead cost a bounds check, a growth
   * check, and a call per pixel — enough to stall the first frame of every
   * stroke that refines an existing mask.
   */
  private blit(snapshot: MaskSnapshot): void {
    // `set()` screens fractional coordinates one at a time; a bulk copy has to
    // do it once, up front. Skipping it was worse than the per-pixel path it
    // replaced: fractional indices write nowhere while `count` still advances,
    // leaving the buffer permanently claiming pixels it does not have.
    assertDecodableOrigin(snapshot.x, snapshot.y);
    assertDecodableArea(snapshot.width, snapshot.height, this.maxPixels);
    // Every in-tree caller arrives via `decodeCanonical`, which already checked
    // this. A host handing us a snapshot it built itself — a model's output,
    // say — does not, and `reserve` clips the overhang away: the mask would
    // come back quietly truncated on its first refining stroke, which is the
    // failure this guard exists to prevent everywhere else.
    assertBoxInsideImage(
      snapshot.x,
      snapshot.y,
      snapshot.width,
      snapshot.height,
      this.imageWidth,
      this.imageHeight,
    );

    this.reserve({
      x: snapshot.x,
      y: snapshot.y,
      width: snapshot.width,
      height: snapshot.height,
    });

    // reserve() clips to the image, so a snapshot poking outside it is written
    // only where it overlaps.
    const left = Math.max(snapshot.x, this.ax);
    const top = Math.max(snapshot.y, this.ay);
    const right = Math.min(snapshot.x + snapshot.width, this.ax + this.aw);
    const bottom = Math.min(snapshot.y + snapshot.height, this.ay + this.ah);

    for (let y = top; y < bottom; y++) {
      let src = (y - snapshot.y) * snapshot.width + (left - snapshot.x);
      let dst = (y - this.ay) * this.aw + (left - this.ax);
      for (let x = left; x < right; x++, src++, dst++) {
        const value = snapshot.data[src] === 1 ? 1 : 0;
        const previous = this.data[dst]!;
        if (previous === value) continue;
        this.data[dst] = value;
        this.count += value === 1 ? 1 : -1;
      }
    }
  }

  get pixelCount(): number {
    return this.count;
  }

  /** The currently allocated region — a superset of the set pixels. */
  get bounds(): MaskRegion {
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
    // nowhere while still moving pixelCount — leaving the buffer claiming
    // pixels it does not have, and snapshot() reporting negative dimensions.
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || y < 0 || x >= this.imageWidth || y >= this.imageHeight) return;

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
      x: this.ax + minCol,
      y: this.ay + minRow,
      width,
      height,
      data: cropped,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
    };
  }

  /**
   * Expands the allocated region to cover `region`, preserving existing pixels.
   *
   * Growing once for a whole disc or stroke segment matters: a radius-500 stamp
   * on a fresh buffer crosses {@link GROWTH_CHUNK} boundaries dozens of times,
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
    const right = Math.min(this.imageWidth, Math.ceil(region.x + region.width));
    const bottom = Math.min(this.imageHeight, Math.ceil(region.y + region.height));
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

    const nx = Math.max(0, Math.floor(minX / GROWTH_CHUNK) * GROWTH_CHUNK);
    const ny = Math.max(0, Math.floor(minY / GROWTH_CHUNK) * GROWTH_CHUNK);
    const nRight = Math.min(this.imageWidth, Math.ceil((maxX + 1) / GROWTH_CHUNK) * GROWTH_CHUNK);
    const nBottom = Math.min(this.imageHeight, Math.ceil((maxY + 1) / GROWTH_CHUNK) * GROWTH_CHUNK);
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
