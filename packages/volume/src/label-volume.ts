import {
  imageToPatient,
  indexToPatient,
  patientToIndex,
  planeNormal,
  sub,
  type PlaneFrame,
  type PlaneIndexMapping,
  type Point2,
  type Vec3,
  type VolumeGrid,
} from '@osdlabel/spatial';
import type { AllocateOptions } from './scalar-volume.js';

/**
 * A dense 3D label map: `slices[k][j * nx + i]` is the label of voxel (i,j,k),
 * 0 = background. One byte per voxel, so up to 255 labels share one volume.
 */
export interface LabelVolume {
  readonly grid: VolumeGrid;
  readonly slices: readonly Uint8Array[];
}

export function allocateLabelVolume(grid: VolumeGrid, options?: AllocateOptions): LabelVolume {
  const per = grid.dimensions[0] * grid.dimensions[1];
  const nz = grid.dimensions[2];
  const slices: Uint8Array[] = [];
  if (options?.contiguous === false) {
    for (let k = 0; k < nz; k++) slices.push(new Uint8Array(per));
  } else {
    const buffer = options?.shared ? new SharedArrayBuffer(per * nz) : new ArrayBuffer(per * nz);
    for (let k = 0; k < nz; k++) slices.push(new Uint8Array(buffer, k * per, per));
  }
  return { grid, slices };
}

/**
 * Visit every voxel of `grid` inside a brush disc drawn on `frame`: voxel
 * centres within `radiusPx` image pixels of `centre` in-plane and within half
 * the frame's thickness out of plane. This is the 3D meaning of one brush
 * stamp on any view — axial, coronal, sagittal or oblique — and is shared by
 * every label-map representation so they stay voxel-for-voxel comparable.
 */
export function forEachVoxelInDisc(
  grid: VolumeGrid,
  frame: PlaneFrame,
  centre: Point2,
  radiusPx: number,
  visit: (i: number, j: number, k: number) => void,
): void {
  const C = imageToPatient(frame, centre);
  const rMm = radiusPx * Math.max(frame.pixelSpacing.x, frame.pixelSpacing.y);
  const half = frame.thickness / 2;
  const n = planeNormal(frame);
  const reach = rMm + half;
  // Index-space bounding box of the patient-space cube around C.
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const P: Vec3 = [
      C[0] + (c & 1 ? reach : -reach),
      C[1] + (c & 2 ? reach : -reach),
      C[2] + (c & 4 ? reach : -reach),
    ];
    const idx = patientToIndex(grid, P);
    lo = [Math.min(lo[0], idx[0]), Math.min(lo[1], idx[1]), Math.min(lo[2], idx[2])];
    hi = [Math.max(hi[0], idx[0]), Math.max(hi[1], idx[1]), Math.max(hi[2], idx[2])];
  }
  const [nx, ny, nz] = grid.dimensions;
  const i0 = Math.max(0, Math.ceil(lo[0]));
  const j0 = Math.max(0, Math.ceil(lo[1]));
  const k0 = Math.max(0, Math.ceil(lo[2]));
  const i1 = Math.min(nx - 1, Math.floor(hi[0]));
  const j1 = Math.min(ny - 1, Math.floor(hi[1]));
  const k1 = Math.min(nz - 1, Math.floor(hi[2]));
  // d(i,j,k) = base + i*a + j*b + k*c, linear in the indices.
  const base = sub(indexToPatient(grid, [0, 0, 0]), C);
  const a = sub(indexToPatient(grid, [1, 0, 0]), indexToPatient(grid, [0, 0, 0]));
  const b = sub(indexToPatient(grid, [0, 1, 0]), indexToPatient(grid, [0, 0, 0]));
  const cc = sub(indexToPatient(grid, [0, 0, 1]), indexToPatient(grid, [0, 0, 0]));
  const r2 = rMm * rMm + 1e-6;
  const halfTol = half + 1e-6;
  const [n0, n1, n2] = n;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      const rx = base[0] + j * b[0] + k * cc[0];
      const ry = base[1] + j * b[1] + k * cc[1];
      const rz = base[2] + j * b[2] + k * cc[2];
      for (let i = i0; i <= i1; i++) {
        const dx = rx + i * a[0];
        const dy = ry + i * a[1];
        const dz = rz + i * a[2];
        const out = dx * n0 + dy * n1 + dz * n2;
        if (out > halfTol || out < -halfTol) continue;
        if (dx * dx + dy * dy + dz * dz - out * out <= r2) visit(i, j, k);
      }
    }
  }
}

/** Paint `value` into every voxel of a brush disc on `frame`. Returns voxels changed. */
export function paintDisc(
  labels: LabelVolume,
  frame: PlaneFrame,
  centre: Point2,
  radiusPx: number,
  value: number,
): number {
  let changed = 0;
  const nx = labels.grid.dimensions[0];
  forEachVoxelInDisc(labels.grid, frame, centre, radiusPx, (i, j, k) => {
    const s = labels.slices[k]!;
    const o = j * nx + i;
    if (s[o] !== value) {
      s[o] = value;
      changed++;
    }
  });
  return changed;
}

/** Nearest-neighbour reslice of a label map (labels must never be interpolated). */
export function resliceLabels(
  labels: LabelVolume,
  m: PlaneIndexMapping,
  width: number,
  height: number,
  out: Uint8Array,
): void {
  const [nx, ny, nz] = labels.grid.dimensions;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = Math.round(m.start[0] + x * m.stepX[0] + y * m.stepY[0]);
      const j = Math.round(m.start[1] + x * m.stepX[1] + y * m.stepY[1]);
      const k = Math.round(m.start[2] + x * m.stepX[2] + y * m.stepY[2]);
      out[y * width + x] =
        i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz
          ? 0
          : labels.slices[k]![j * nx + i]!;
    }
  }
}
