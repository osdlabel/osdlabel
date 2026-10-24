import type { Vec3, VolumeGrid } from '@osdlabel/spatial';
import { allocateScalarVolume, type ScalarVolume } from './scalar-volume.js';

/**
 * Index-axis order of a permuted copy: `order[a]` is the source axis that
 * becomes axis `a` of the copy (0 = i, 1 = j, 2 = k).
 */
export type AxisOrder = readonly [number, number, number];

/** Sagittal-friendly order: slices along i, rows along k, columns along j. */
export const SAGITTAL_MAJOR: AxisOrder = [1, 2, 0];

/**
 * The same sampling grid with its index axes reordered. The patient-space
 * position of every voxel is unchanged, so any `PlaneFrame` maps onto the
 * permuted grid through `planeIndexMapping` as usual.
 */
export function permuteGrid(grid: VolumeGrid, order: AxisOrder): VolumeGrid {
  const [a, b, c] = order;
  if (new Set(order).size !== 3 || ![a, b, c].every((x) => x === 0 || x === 1 || x === 2)) {
    throw new RangeError(`not an axis permutation: ${order.join(',')}`);
  }
  const spacing: Vec3 = [grid.spacing[a]!, grid.spacing[b]!, grid.spacing[c]!];
  return {
    dimensions: [grid.dimensions[a]!, grid.dimensions[b]!, grid.dimensions[c]!],
    spacing,
    origin: grid.origin,
    direction: [grid.direction[a]!, grid.direction[b]!, grid.direction[c]!],
  };
}

/**
 * A copy of `volume` stored in another axis order. Slice-wise storage makes
 * the plane perpendicular to k a contiguous gather and the sagittal plane
 * (fixed i) the worst case: every sample is `nx` voxels from the last. A
 * second copy in `SAGITTAL_MAJOR` order turns that view into a contiguous
 * read, at the price of the whole volume again in memory (and the copy time).
 * The copy goes through the same `reslice`, so outputs are identical.
 */
export function permuteVolume(
  volume: ScalarVolume,
  order: AxisOrder,
  options?: { readonly shared?: boolean | undefined },
): ScalarVolume {
  const g = permuteGrid(volume.grid, order);
  const out = allocateScalarVolume(g, { shared: options?.shared });
  const [nx, ny, nz] = volume.grid.dimensions;
  const px = g.dimensions[0];
  // Destination offset within a destination slice for a unit step along each
  // SOURCE axis; the source axis that becomes the slice axis contributes 0.
  const stride: [number, number, number] = [0, 0, 0];
  stride[order[0]] = 1;
  stride[order[1]] = px;
  const [si, sj, sk] = stride;
  const sliceAxis = order[2];
  const dst = out.slices;
  for (let k = 0; k < nz; k++) {
    const src = volume.slices[k]!;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      const base = j * sj + k * sk;
      if (sliceAxis === 0) {
        for (let i = 0; i < nx; i++) dst[i]![base] = src[row + i]!;
      } else {
        const d = dst[sliceAxis === 1 ? j : k]!;
        for (let i = 0; i < nx; i++) d[base + i * si] = src[row + i]!;
      }
    }
  }
  return out;
}
