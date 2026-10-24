import { BoundedDenseMaskBuffer, stampCircle } from '@osdlabel/mask';
import {
  dot,
  patientToIndex,
  planeNormal,
  type PlaneFrame,
  type PlaneIndexMapping,
  type Point2,
  type VolumeGrid,
} from '@osdlabel/spatial';
import { forEachVoxelInDisc } from './label-volume.js';

/**
 * The alternative 3D label-map representation: one `@osdlabel/mask` 2D buffer
 * per axial slice, created on first paint. This is what reusing PR #149's
 * per-image masks for a volume looks like — the mask package needs no change,
 * but painting on a coronal / sagittal / oblique view scatters into many
 * slices, and showing a non-axial view reads one row from every mask.
 */
export class SliceMaskStack {
  readonly grid: VolumeGrid;
  readonly masks = new Map<number, BoundedDenseMaskBuffer>();
  private readonly maxPixels: number | undefined;

  constructor(grid: VolumeGrid, maxPixels?: number) {
    this.grid = grid;
    this.maxPixels = maxPixels;
  }

  private mask(k: number): BoundedDenseMaskBuffer {
    let m = this.masks.get(k);
    if (!m) {
      m = new BoundedDenseMaskBuffer({
        imageWidth: this.grid.dimensions[0],
        imageHeight: this.grid.dimensions[1],
        ...(this.maxPixels !== undefined ? { maxPixels: this.maxPixels } : {}),
      });
      this.masks.set(k, m);
    }
    return m;
  }

  /**
   * Paint a brush disc drawn on `frame`. A plane parallel to the slices whose
   * pixels coincide with voxels goes through the mask package's own
   * `stampCircle`; any other plane visits voxels and sets them one by one.
   */
  paintDisc(frame: PlaneFrame, centre: Point2, radiusPx: number): void {
    const n = planeNormal(frame);
    const [iDir, jDir, kDir] = this.grid.direction;
    const axial =
      Math.abs(Math.abs(dot(n, kDir)) - 1) < 1e-9 &&
      Math.abs(dot(frame.rowDirection, iDir) - 1) < 1e-9 &&
      Math.abs(dot(frame.columnDirection, jDir) - 1) < 1e-9 &&
      frame.pixelSpacing.x === this.grid.spacing[0] &&
      frame.pixelSpacing.y === this.grid.spacing[1];
    if (axial) {
      const idx = patientToIndex(this.grid, frame.origin);
      const k = Math.round(idx[2]);
      if (k < 0 || k >= this.grid.dimensions[2]) return;
      // Frame pixel (0,0)'s centre sits at voxel idx; mask pixel (i,j) covers [i,i+1).
      stampCircle(this.mask(k), centre.x + idx[0], centre.y + idx[1], radiusPx, 1);
      return;
    }
    forEachVoxelInDisc(this.grid, frame, centre, radiusPx, (i, j, k) => {
      this.mask(k).set(i, j, 1);
    });
  }

  /** Nearest-neighbour reslice through the stack. */
  reslice(m: PlaneIndexMapping, width: number, height: number, out: Uint8Array): void {
    const [nx, ny, nz] = this.grid.dimensions;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = Math.round(m.start[0] + x * m.stepX[0] + y * m.stepY[0]);
        const j = Math.round(m.start[1] + x * m.stepX[1] + y * m.stepY[1]);
        const k = Math.round(m.start[2] + x * m.stepX[2] + y * m.stepY[2]);
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) {
          out[y * width + x] = 0;
          continue;
        }
        const mask = this.masks.get(k);
        out[y * width + x] = mask ? mask.get(i, j) : 0;
      }
    }
  }

  /** Bytes the mask buffers hold (each allocates `bounds.width * bounds.height`). */
  byteLength(): number {
    let n = 0;
    for (const m of this.masks.values()) n += m.bounds.width * m.bounds.height;
    return n;
  }

  voxelCount(): number {
    let n = 0;
    for (const m of this.masks.values()) n += m.pixelCount;
    return n;
  }
}
