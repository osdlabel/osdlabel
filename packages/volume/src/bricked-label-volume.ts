import type { PlaneFrame, PlaneIndexMapping, Point2, VolumeGrid } from '@osdlabel/spatial';
import { forEachSpanInDisc } from './label-volume.js';

/** Brick edge in voxels (a power of two): 32^3 uint8 = 32 KiB per brick. */
export const BRICK_SHIFT = 5;
const B = 1 << BRICK_SHIFT;
const MASK = B - 1;

/**
 * A sparse 3D label map: the grid is cut into 32^3-voxel bricks, and a brick's
 * 32 KiB is allocated the first time a voxel in it is painted. Untouched
 * space costs one null pointer per brick (6,400 for 512x512x400), so memory
 * follows the painted extent rather than the grid, every voxel stays O(1)
 * (one array index and a shift), and painting from any view touches a few
 * bricks instead of one buffer per slice. A brick never moves, so a renderer
 * that wants a dense buffer (Niivue's drawing layer, a GPU texture) can be
 * updated brick by brick.
 */
export class BrickedLabelVolume {
  readonly grid: VolumeGrid;
  /** Bricks along i, j, k. */
  readonly bricksPerAxis: readonly [number, number, number];
  readonly bricks: (Uint8Array | null)[];

  constructor(grid: VolumeGrid) {
    this.grid = grid;
    const [nx, ny, nz] = grid.dimensions;
    this.bricksPerAxis = [Math.ceil(nx / B), Math.ceil(ny / B), Math.ceil(nz / B)];
    const [bx, by, bz] = this.bricksPerAxis;
    this.bricks = new Array<Uint8Array | null>(bx * by * bz).fill(null);
  }

  private index(i: number, j: number, k: number): number {
    const [bx, by] = this.bricksPerAxis;
    return (i >> BRICK_SHIFT) + bx * ((j >> BRICK_SHIFT) + by * (k >> BRICK_SHIFT));
  }

  get(i: number, j: number, k: number): number {
    const b = this.bricks[this.index(i, j, k)];
    return b ? b[(i & MASK) | ((j & MASK) << BRICK_SHIFT) | ((k & MASK) << (2 * BRICK_SHIFT))]! : 0;
  }

  /** Write `value` into voxels `[iStart, iEnd]` of row (j, k), allocating bricks as needed. */
  fillRow(k: number, j: number, iStart: number, iEnd: number, value: number): void {
    const rowOffset = ((j & MASK) << BRICK_SHIFT) | ((k & MASK) << (2 * BRICK_SHIFT));
    let i = iStart;
    while (i <= iEnd) {
      const end = Math.min(iEnd, (i | MASK) >>> 0);
      const bi = this.index(i, j, k);
      let b = this.bricks[bi];
      if (!b) {
        if (value === 0) {
          i = end + 1;
          continue;
        }
        b = new Uint8Array(B * B * B);
        this.bricks[bi] = b;
      }
      b.fill(value, rowOffset + (i & MASK), rowOffset + (end & MASK) + 1);
      i = end + 1;
    }
  }

  /** Paint a brush disc on `frame` (the same voxels as `paintDisc` / `fillDisc`). Returns voxels covered. */
  fillDisc(frame: PlaneFrame, centre: Point2, radiusPx: number, value: number): number {
    let covered = 0;
    forEachSpanInDisc(this.grid, frame, centre, radiusPx, (k, j, iStart, iEnd) => {
      this.fillRow(k, j, iStart, iEnd, value);
      covered += iEnd - iStart + 1;
    });
    return covered;
  }

  /** Nearest-neighbour reslice into `out` (same contract as `resliceLabels`). */
  reslice(m: PlaneIndexMapping, width: number, height: number, out: Uint8Array): void {
    const [nx, ny, nz] = this.grid.dimensions;
    const [bx, by] = this.bricksPerAxis;
    const bricks = this.bricks;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = Math.round(m.start[0] + x * m.stepX[0] + y * m.stepY[0]);
        const j = Math.round(m.start[1] + x * m.stepX[1] + y * m.stepY[1]);
        const k = Math.round(m.start[2] + x * m.stepX[2] + y * m.stepY[2]);
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) {
          out[y * width + x] = 0;
          continue;
        }
        const b = bricks[(i >> BRICK_SHIFT) + bx * ((j >> BRICK_SHIFT) + by * (k >> BRICK_SHIFT))];
        out[y * width + x] = b
          ? b[(i & MASK) | ((j & MASK) << BRICK_SHIFT) | ((k & MASK) << (2 * BRICK_SHIFT))]!
          : 0;
      }
    }
  }

  /** Bricks allocated so far. */
  allocatedBricks(): number {
    let n = 0;
    for (const b of this.bricks) if (b) n++;
    return n;
  }

  /** Bytes held: allocated bricks plus the pointer table (8 bytes per slot). */
  byteLength(): number {
    return this.allocatedBricks() * B * B * B + this.bricks.length * 8;
  }
}
