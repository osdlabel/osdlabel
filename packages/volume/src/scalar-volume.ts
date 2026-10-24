import type { VolumeGrid } from '@osdlabel/spatial';

/**
 * A 3D scalar volume (CT Hounsfield units, MR intensities) stored slice by
 * slice: `slices[k]` holds the `nx * ny` voxels of slice `k`, row-major.
 *
 * Slice-wise storage is deliberate. It is how a DICOM series arrives (one
 * decoded frame per instance, so a stack becomes a volume with zero copies),
 * it streams (slices can be filled in as they decode), and it sidesteps the
 * browser's per-ArrayBuffer cap (2 GiB in Chrome) that a single buffer for a
 * large volume would hit. The slices may still share one buffer — see
 * {@link contiguousVoxels} — which a GPU upload or a third-party renderer can
 * then take without copying.
 */
export interface ScalarVolume {
  readonly grid: VolumeGrid;
  readonly slices: readonly Int16Array[];
}

export interface AllocateOptions {
  /** Back the voxels with one SharedArrayBuffer so workers can read them in place. */
  readonly shared?: boolean | undefined;
  /** One buffer for all slices (default) or one buffer per slice. */
  readonly contiguous?: boolean | undefined;
}

function voxelsPerSlice(grid: VolumeGrid): number {
  return grid.dimensions[0] * grid.dimensions[1];
}

/** Allocate a zero-filled volume for `grid`. */
export function allocateScalarVolume(grid: VolumeGrid, options?: AllocateOptions): ScalarVolume {
  const per = voxelsPerSlice(grid);
  const nz = grid.dimensions[2];
  const slices: Int16Array[] = [];
  if (options?.contiguous === false) {
    for (let k = 0; k < nz; k++) {
      slices.push(
        options.shared ? new Int16Array(new SharedArrayBuffer(per * 2)) : new Int16Array(per),
      );
    }
  } else {
    const bytes = per * nz * 2;
    const buffer = options?.shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    for (let k = 0; k < nz; k++) slices.push(new Int16Array(buffer, k * per * 2, per));
  }
  return { grid, slices };
}

/**
 * Wrap already-decoded slices (e.g. one per DICOM instance, sorted by position
 * along the normal) as a volume, without copying.
 */
export function volumeFromSlices(grid: VolumeGrid, slices: readonly Int16Array[]): ScalarVolume {
  const per = voxelsPerSlice(grid);
  if (slices.length !== grid.dimensions[2]) {
    throw new RangeError(`expected ${grid.dimensions[2]} slices, got ${slices.length}`);
  }
  for (const s of slices) {
    if (s.length !== per) throw new RangeError(`slice has ${s.length} voxels, expected ${per}`);
  }
  return { grid, slices };
}

/**
 * One view over every voxel when the slices are consecutive in a single
 * buffer, else `null`. A GPU upload or a renderer that wants one typed array
 * (Niivue, vtk.js) can take this without a copy.
 */
export function contiguousVoxels(volume: ScalarVolume): Int16Array | null {
  const first = volume.slices[0];
  if (!first) return null;
  const per = voxelsPerSlice(volume.grid);
  for (let k = 1; k < volume.slices.length; k++) {
    const s = volume.slices[k]!;
    if (s.buffer !== first.buffer || s.byteOffset !== first.byteOffset + k * per * 2) return null;
  }
  return new Int16Array(first.buffer, first.byteOffset, per * volume.slices.length);
}

/** Bytes held by the voxel arrays (not counting any GPU copy). */
export function volumeByteLength(volume: ScalarVolume): number {
  return volume.slices.reduce((n, s) => n + s.byteLength, 0);
}
