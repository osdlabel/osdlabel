import type { PlaneIndexMapping, Vec3 } from '@osdlabel/spatial';
import type { ScalarVolume } from './scalar-volume.js';

export type Interpolation = 'nearest' | 'linear';

export interface ResliceOptions {
  /** Default `'linear'` (trilinear; bilinear/linear on axis-aligned planes). */
  readonly interpolation?: Interpolation | undefined;
  /** Value written where the plane leaves the volume. Default -1024 (air, in HU). */
  readonly background?: number | undefined;
  /** First output row to write (inclusive). Lets workers split one plane. Default 0. */
  readonly rowStart?: number | undefined;
  /** Last output row to write (exclusive). Default `height`. */
  readonly rowEnd?: number | undefined;
}

/**
 * Which inner loop ran — reported so a benchmark can tell an orthogonal plane
 * that hit the fast path from one that silently fell back to trilinear.
 */
export type ReslicePath = 'gather' | 'separable' | 'trilinear' | 'nearest';

const AXIS_EPSILON = 1e-9;

/** Index of the only non-zero component, or -1. */
function soleAxis(v: Vec3): number {
  let axis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(v[a]!) > AXIS_EPSILON) {
      if (axis !== -1) return -1;
      axis = a;
    }
  }
  return axis;
}

/** Per-sample lookup along one axis: lower / upper voxel, weight of the upper, validity. */
interface AxisTable {
  readonly i0: Int32Array;
  readonly i1: Int32Array;
  readonly w: Float32Array;
  readonly valid: Uint8Array;
  /** Every weight is zero (integer sampling positions). */
  readonly integral: boolean;
}

function axisTable(
  start: number,
  step: number,
  count: number,
  n: number,
  linear: boolean,
): AxisTable {
  const i0 = new Int32Array(count);
  const i1 = new Int32Array(count);
  const w = new Float32Array(count);
  const valid = new Uint8Array(count);
  let integral = true;
  for (let s = 0; s < count; s++) {
    const t = start + s * step;
    if (linear) {
      if (t < -AXIS_EPSILON || t > n - 1 + AXIS_EPSILON) continue;
      const tc = Math.min(Math.max(t, 0), n - 1);
      let f = Math.floor(tc);
      if (f >= n - 1) f = Math.max(0, n - 2);
      let frac = n === 1 ? 0 : tc - f;
      if (frac < 1e-6) frac = 0;
      else if (frac > 1 - 1e-6) {
        f = Math.min(f + 1, n - 1);
        frac = 0;
      }
      i0[s] = f;
      i1[s] = Math.min(f + 1, n - 1);
      w[s] = frac;
      if (frac !== 0) integral = false;
      valid[s] = 1;
    } else {
      const r = Math.round(t);
      if (r < 0 || r > n - 1) continue;
      i0[s] = r;
      i1[s] = r;
      valid[s] = 1;
    }
  }
  return { i0, i1, w, valid, integral };
}

/**
 * Sample `volume` on the plane described by `mapping` into the row-major
 * `width x height` image `out`, in place.
 *
 * Axis-aligned planes (axial / coronal / sagittal, at any slice position and
 * output spacing) take a separable path that turns into a plain gather when
 * the plane lands on voxel centres; anything else is sampled trilinearly
 * (or nearest). The function is pure arithmetic over typed arrays, so it runs
 * unchanged in a worker on a SharedArrayBuffer-backed volume; `rowStart` /
 * `rowEnd` split one plane between workers.
 */
export function reslice(
  volume: ScalarVolume,
  mapping: PlaneIndexMapping,
  width: number,
  height: number,
  out: Int16Array,
  options?: ResliceOptions,
): ReslicePath {
  const linear = (options?.interpolation ?? 'linear') === 'linear';
  const bg = options?.background ?? -1024;
  const y0 = options?.rowStart ?? 0;
  const y1 = options?.rowEnd ?? height;
  const ax = soleAxis(mapping.stepX);
  const ay = soleAxis(mapping.stepY);
  if (ax >= 0 && ay >= 0 && ax !== ay && ax !== 2) {
    return resliceSeparable(volume, mapping, ax, ay, width, out, linear, bg, y0, y1);
  }
  return linear
    ? resliceTrilinear(volume, mapping, width, out, bg, y0, y1)
    : resliceNearest(volume, mapping, width, out, bg, y0, y1);
}

function resliceSeparable(
  volume: ScalarVolume,
  m: PlaneIndexMapping,
  ax: number,
  ay: number,
  width: number,
  out: Int16Array,
  linear: boolean,
  bg: number,
  y0: number,
  y1: number,
): ReslicePath {
  const dims = volume.grid.dimensions;
  const nx = dims[0];
  const an = 3 - ax - ay;
  const slices = volume.slices;
  const tx = axisTable(m.start[ax]!, m.stepX[ax]!, width, dims[ax]!, linear);
  const ty = axisTable(m.start[ay]! + y0 * m.stepY[ay]!, m.stepY[ay]!, y1 - y0, dims[ay]!, linear);
  const tn = axisTable(m.start[an]!, 0, 1, dims[an]!, linear);
  const strideOf = (axis: number): number => (axis === 0 ? 1 : nx);
  const sx = strideOf(ax);
  const fastX = tx.integral;
  if (tn.valid[0] === 0) {
    out.fill(bg, y0 * width, y1 * width);
    return 'gather';
  }
  let path: ReslicePath = 'gather';

  if (an === 2) {
    // k is the plane normal: two fixed slices, bilinear within them.
    const sA = slices[tn.i0[0]!]!;
    const sB = slices[tn.i1[0]!]!;
    const wk = tn.w[0]!;
    const sy = strideOf(ay);
    for (let r = 0; r < y1 - y0; r++) {
      const base = (y0 + r) * width;
      if (ty.valid[r] === 0) {
        out.fill(bg, base, base + width);
        continue;
      }
      const oy0 = ty.i0[r]! * sy;
      const oy1 = ty.i1[r]! * sy;
      const wy = ty.w[r]!;
      if (fastX && wy === 0 && wk === 0) {
        for (let x = 0; x < width; x++) {
          out[base + x] = tx.valid[x] === 0 ? bg : sA[oy0 + tx.i0[x]! * sx]!;
        }
        continue;
      }
      path = 'separable';
      for (let x = 0; x < width; x++) {
        if (tx.valid[x] === 0) {
          out[base + x] = bg;
          continue;
        }
        const ox0 = tx.i0[x]! * sx;
        const ox1 = tx.i1[x]! * sx;
        const wx = tx.w[x]!;
        const a0 = sA[oy0 + ox0]! + (sA[oy0 + ox1]! - sA[oy0 + ox0]!) * wx;
        const a1 = sA[oy1 + ox0]! + (sA[oy1 + ox1]! - sA[oy1 + ox0]!) * wx;
        let v = a0 + (a1 - a0) * wy;
        if (wk !== 0) {
          const b0 = sB[oy0 + ox0]! + (sB[oy0 + ox1]! - sB[oy0 + ox0]!) * wx;
          const b1 = sB[oy1 + ox0]! + (sB[oy1 + ox1]! - sB[oy1 + ox0]!) * wx;
          v += (b0 + (b1 - b0) * wy - v) * wk;
        }
        out[base + x] = Math.round(v);
      }
    }
    return path;
  }

  // k runs down the rows (coronal / sagittal): each row picks two slices.
  const sn = strideOf(an);
  const on0 = tn.i0[0]! * sn;
  const on1 = tn.i1[0]! * sn;
  const wn = tn.w[0]!;
  for (let r = 0; r < y1 - y0; r++) {
    const base = (y0 + r) * width;
    if (ty.valid[r] === 0) {
      out.fill(bg, base, base + width);
      continue;
    }
    const sA = slices[ty.i0[r]!]!;
    const sB = slices[ty.i1[r]!]!;
    const wk = ty.w[r]!;
    if (fastX && wn === 0) {
      if (wk === 0) {
        for (let x = 0; x < width; x++) {
          out[base + x] = tx.valid[x] === 0 ? bg : sA[on0 + tx.i0[x]! * sx]!;
        }
      } else {
        path = 'separable';
        for (let x = 0; x < width; x++) {
          if (tx.valid[x] === 0) {
            out[base + x] = bg;
            continue;
          }
          const o = on0 + tx.i0[x]! * sx;
          const a = sA[o]!;
          out[base + x] = Math.round(a + (sB[o]! - a) * wk);
        }
      }
      continue;
    }
    path = 'separable';
    for (let x = 0; x < width; x++) {
      if (tx.valid[x] === 0) {
        out[base + x] = bg;
        continue;
      }
      const ox0 = tx.i0[x]! * sx;
      const ox1 = tx.i1[x]! * sx;
      const wx = tx.w[x]!;
      const a0 = sA[on0 + ox0]! + (sA[on0 + ox1]! - sA[on0 + ox0]!) * wx;
      const a1 = sA[on1 + ox0]! + (sA[on1 + ox1]! - sA[on1 + ox0]!) * wx;
      const b0 = sB[on0 + ox0]! + (sB[on0 + ox1]! - sB[on0 + ox0]!) * wx;
      const b1 = sB[on1 + ox0]! + (sB[on1 + ox1]! - sB[on1 + ox0]!) * wx;
      const a = a0 + (a1 - a0) * wn;
      const b = b0 + (b1 - b0) * wn;
      out[base + x] = Math.round(a + (b - a) * wk);
    }
  }
  return path;
}

function resliceTrilinear(
  volume: ScalarVolume,
  m: PlaneIndexMapping,
  width: number,
  out: Int16Array,
  bg: number,
  y0: number,
  y1: number,
): ReslicePath {
  const [nx, ny, nz] = volume.grid.dimensions;
  const slices = volume.slices;
  const maxI = nx - 1;
  const maxJ = ny - 1;
  const maxK = nz - 1;
  const [si, sj, sk] = m.start;
  const [xi, xj, xk] = m.stepX;
  const [yi, yj, yk] = m.stepY;
  for (let y = y0; y < y1; y++) {
    const ri = si + y * yi;
    const rj = sj + y * yj;
    const rk = sk + y * yk;
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const i = ri + x * xi;
      const j = rj + x * xj;
      const k = rk + x * xk;
      if (i < 0 || j < 0 || k < 0 || i > maxI || j > maxJ || k > maxK) {
        out[base + x] = bg;
        continue;
      }
      let fi = i | 0;
      let fj = j | 0;
      let fk = k | 0;
      if (fi === maxI) fi = maxI - 1;
      if (fj === maxJ) fj = maxJ - 1;
      if (fk === maxK) fk = maxK - 1;
      const ti = i - fi;
      const tj = j - fj;
      const tk = k - fk;
      const s0 = slices[fk]!;
      const s1 = slices[fk + 1]!;
      const o = fj * nx + fi;
      const o2 = o + nx;
      const p00 = s0[o]!;
      const p01 = s0[o2]!;
      const c0a = p00 + (s0[o + 1]! - p00) * ti;
      const c0b = p01 + (s0[o2 + 1]! - p01) * ti;
      const c0 = c0a + (c0b - c0a) * tj;
      const q00 = s1[o]!;
      const q01 = s1[o2]!;
      const c1a = q00 + (s1[o + 1]! - q00) * ti;
      const c1b = q01 + (s1[o2 + 1]! - q01) * ti;
      const c1 = c1a + (c1b - c1a) * tj;
      out[base + x] = Math.round(c0 + (c1 - c0) * tk);
    }
  }
  return 'trilinear';
}

function resliceNearest(
  volume: ScalarVolume,
  m: PlaneIndexMapping,
  width: number,
  out: Int16Array,
  bg: number,
  y0: number,
  y1: number,
): ReslicePath {
  const [nx, ny, nz] = volume.grid.dimensions;
  const slices = volume.slices;
  const [si, sj, sk] = m.start;
  const [xi, xj, xk] = m.stepX;
  const [yi, yj, yk] = m.stepY;
  for (let y = y0; y < y1; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const i = Math.round(si + y * yi + x * xi);
      const j = Math.round(sj + y * yj + x * xj);
      const k = Math.round(sk + y * yk + x * xk);
      out[base + x] =
        i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? bg : slices[k]![j * nx + i]!;
    }
  }
  return 'nearest';
}
