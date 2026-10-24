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
 * The index-space set-up of one brush disc on `frame`, shared by the voxel and
 * span enumerators so both visit exactly the same voxels. A voxel (i,j,k) is
 * inside when its centre is within `radiusPx` image pixels of `centre`
 * in-plane and within half the frame's thickness out of plane:
 * `d(i,j,k) = base + i*a + j*b + k*c` is its offset from the disc centre in
 * patient mm, `out = d . n` its out-of-plane distance.
 */
interface DiscSetup {
  readonly i0: number;
  readonly i1: number;
  readonly j0: number;
  readonly j1: number;
  readonly k0: number;
  readonly k1: number;
  readonly base: Vec3;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly n: Vec3;
  readonly r2: number;
  readonly halfTol: number;
}

function discSetup(
  grid: VolumeGrid,
  frame: PlaneFrame,
  centre: Point2,
  radiusPx: number,
): DiscSetup {
  const C = imageToPatient(frame, centre);
  const rMm = radiusPx * Math.max(frame.pixelSpacing.x, frame.pixelSpacing.y);
  const half = frame.thickness / 2;
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
  const origin = indexToPatient(grid, [0, 0, 0]);
  return {
    i0: Math.max(0, Math.ceil(lo[0])),
    j0: Math.max(0, Math.ceil(lo[1])),
    k0: Math.max(0, Math.ceil(lo[2])),
    i1: Math.min(nx - 1, Math.floor(hi[0])),
    j1: Math.min(ny - 1, Math.floor(hi[1])),
    k1: Math.min(nz - 1, Math.floor(hi[2])),
    base: sub(origin, C),
    a: sub(indexToPatient(grid, [1, 0, 0]), origin),
    b: sub(indexToPatient(grid, [0, 1, 0]), origin),
    c: sub(indexToPatient(grid, [0, 0, 1]), origin),
    n: planeNormal(frame),
    r2: rMm * rMm + 1e-6,
    halfTol: half + 1e-6,
  };
}

/**
 * Visit every voxel of `grid` inside a brush disc drawn on `frame` (the
 * membership test is described on `DiscSetup`). This is the 3D meaning of one
 * brush stamp on any view — axial, coronal, sagittal or oblique — and is
 * shared by every label-map representation so they stay voxel-for-voxel
 * comparable.
 */
export function forEachVoxelInDisc(
  grid: VolumeGrid,
  frame: PlaneFrame,
  centre: Point2,
  radiusPx: number,
  visit: (i: number, j: number, k: number) => void,
): void {
  const s = discSetup(grid, frame, centre, radiusPx);
  const { base, a, b, c: cc, r2, halfTol } = s;
  const [n0, n1, n2] = s.n;
  for (let k = s.k0; k <= s.k1; k++) {
    for (let j = s.j0; j <= s.j1; j++) {
      const rx = base[0] + j * b[0] + k * cc[0];
      const ry = base[1] + j * b[1] + k * cc[1];
      const rz = base[2] + j * b[2] + k * cc[2];
      for (let i = s.i0; i <= s.i1; i++) {
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

/** The per-voxel test of {@link forEachVoxelInDisc}, for voxel i of a row whose i=0 offset is (rx, ry, rz). */
function insideDisc(
  rx: number,
  ry: number,
  rz: number,
  i: number,
  a: Vec3,
  n: Vec3,
  halfTol: number,
  r2: number,
): boolean {
  const dx = rx + i * a[0];
  const dy = ry + i * a[1];
  const dz = rz + i * a[2];
  const out = dx * n[0] + dy * n[1] + dz * n[2];
  if (out > halfTol || out < -halfTol) return false;
  return dx * dx + dy * dy + dz * dz - out * out <= r2;
}

/**
 * The same voxels as {@link forEachVoxelInDisc}, delivered as one inclusive
 * run `[iStart, iEnd]` per (j, k) row. The disc is the intersection of a slab
 * and a cylinder, both convex, so its voxels along any i row are contiguous:
 * the run's ends are solved in closed form, then snapped to the exact
 * per-voxel test so the voxel set is identical (unit-tested).
 */
export function forEachSpanInDisc(
  grid: VolumeGrid,
  frame: PlaneFrame,
  centre: Point2,
  radiusPx: number,
  visit: (k: number, j: number, iStart: number, iEnd: number) => void,
): void {
  const s = discSetup(grid, frame, centre, radiusPx);
  const { base, a, b, c: cc, r2, halfTol, i0, i1 } = s;
  const [n0, n1, n2] = s.n;
  const o1 = a[0] * n0 + a[1] * n1 + a[2] * n2;
  const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  const A = aa - o1 * o1;
  for (let k = s.k0; k <= s.k1; k++) {
    for (let j = s.j0; j <= s.j1; j++) {
      const rx = base[0] + j * b[0] + k * cc[0];
      const ry = base[1] + j * b[1] + k * cc[1];
      const rz = base[2] + j * b[2] + k * cc[2];
      const inside = (i: number): boolean => insideDisc(rx, ry, rz, i, a, s.n, halfTol, r2);
      const o0 = rx * n0 + ry * n1 + rz * n2;
      let lo = i0;
      let hi = i1;
      // Slab: -halfTol <= o0 + i*o1 <= halfTol.
      if (Math.abs(o1) > 1e-12) {
        const t1 = (-halfTol - o0) / o1;
        const t2 = (halfTol - o0) / o1;
        lo = Math.max(lo, Math.ceil(Math.min(t1, t2)));
        hi = Math.min(hi, Math.floor(Math.max(t1, t2)));
      } else if (o0 > halfTol || o0 < -halfTol) {
        continue;
      }
      // Cylinder: A*i^2 + B*i + C <= 0 with A >= 0.
      const B = 2 * (rx * a[0] + ry * a[1] + rz * a[2] - o0 * o1);
      const C = rx * rx + ry * ry + rz * rz - o0 * o0 - r2;
      if (A > 1e-12) {
        let disc = B * B - 4 * A * C;
        if (disc < 0) {
          if (disc < -1e-9 * (B * B + 1)) continue;
          disc = 0;
        }
        const sq = Math.sqrt(disc);
        lo = Math.max(lo, Math.ceil((-B - sq) / (2 * A)));
        hi = Math.min(hi, Math.floor((-B + sq) / (2 * A)));
      } else if (Math.abs(B) > 1e-12) {
        if (B > 0) hi = Math.min(hi, Math.floor(-C / B));
        else lo = Math.max(lo, Math.ceil(-C / B));
      } else if (C > 0) {
        continue;
      }
      if (lo > hi) {
        // Rounding emptied a run shorter than a voxel: test the voxels either side.
        const below = Math.max(i0, Math.min(i1, hi));
        const above = Math.max(i0, Math.min(i1, lo));
        if (inside(below)) lo = hi = below;
        else if (inside(above)) lo = hi = above;
        else continue;
      }
      // Snap the closed-form ends to the exact per-voxel test.
      while (lo <= hi && !inside(lo)) lo++;
      while (hi >= lo && !inside(hi)) hi--;
      if (lo > hi) continue;
      while (lo > i0 && inside(lo - 1)) lo--;
      while (hi < i1 && inside(hi + 1)) hi++;
      visit(k, j, lo, hi);
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

/**
 * {@link paintDisc} through {@link forEachSpanInDisc}: one `fill` per row run
 * instead of a callback per voxel. Returns the voxels covered (not changed).
 */
export function fillDisc(
  labels: LabelVolume,
  frame: PlaneFrame,
  centre: Point2,
  radiusPx: number,
  value: number,
): number {
  let covered = 0;
  const nx = labels.grid.dimensions[0];
  forEachSpanInDisc(labels.grid, frame, centre, radiusPx, (k, j, iStart, iEnd) => {
    const o = j * nx;
    labels.slices[k]!.fill(value, o + iStart, o + iEnd + 1);
    covered += iEnd - iStart + 1;
  });
  return covered;
}

/**
 * Nearest-neighbour reslice of a label map (labels must never be
 * interpolated). The slice lookup is hoisted: it runs only when the sampled
 * k changes, which on an axial view is once per call.
 */
export function resliceLabels(
  labels: LabelVolume,
  m: PlaneIndexMapping,
  width: number,
  height: number,
  out: Uint8Array,
): void {
  const [nx, ny, nz] = labels.grid.dimensions;
  let lastK = -1;
  let slice: Uint8Array | undefined;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = Math.round(m.start[0] + x * m.stepX[0] + y * m.stepY[0]);
      const j = Math.round(m.start[1] + x * m.stepX[1] + y * m.stepY[1]);
      const k = Math.round(m.start[2] + x * m.stepX[2] + y * m.stepY[2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) {
        out[y * width + x] = 0;
        continue;
      }
      if (k !== lastK) {
        lastK = k;
        slice = labels.slices[k];
      }
      out[y * width + x] = slice![j * nx + i]!;
    }
  }
}
