import type { ScalarVolume } from './scalar-volume.js';

/**
 * One ellipsoid of the 3D Shepp-Logan head phantom (Toft's "modified" contrast
 * table), in normalized coordinates `[-1, 1]^3`. Rotation is about z only
 * (`phiDeg`); the published table's small theta / psi tilts are dropped.
 */
interface Ellipsoid {
  readonly value: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly phiDeg: number;
}

const SHEPP_LOGAN_3D: readonly Ellipsoid[] = [
  { value: 1, a: 0.69, b: 0.92, c: 0.81, x0: 0, y0: 0, z0: 0, phiDeg: 0 },
  { value: -0.8, a: 0.6624, b: 0.874, c: 0.78, x0: 0, y0: -0.0184, z0: 0, phiDeg: 0 },
  { value: -0.2, a: 0.11, b: 0.31, c: 0.22, x0: 0.22, y0: 0, z0: 0, phiDeg: -18 },
  { value: -0.2, a: 0.16, b: 0.41, c: 0.28, x0: -0.22, y0: 0, z0: 0, phiDeg: 18 },
  { value: 0.1, a: 0.21, b: 0.25, c: 0.41, x0: 0, y0: 0.35, z0: -0.15, phiDeg: 0 },
  { value: 0.1, a: 0.046, b: 0.046, c: 0.05, x0: 0, y0: 0.1, z0: 0.25, phiDeg: 0 },
  { value: 0.1, a: 0.046, b: 0.046, c: 0.05, x0: 0, y0: -0.1, z0: 0.25, phiDeg: 0 },
  { value: 0.1, a: 0.046, b: 0.023, c: 0.05, x0: -0.08, y0: -0.605, z0: 0, phiDeg: 0 },
  { value: 0.1, a: 0.023, b: 0.023, c: 0.02, x0: 0, y0: -0.606, z0: 0, phiDeg: 0 },
  { value: 0.1, a: 0.023, b: 0.046, c: 0.02, x0: 0.06, y0: -0.605, z0: 0, phiDeg: 0 },
];

/** Phantom intensity -> Hounsfield units: air outside, ~1000 HU skull, ~40 HU brain. */
function toHu(v: number, inside: boolean): number {
  if (!inside) return -1000;
  return Math.round(40 + (v - 0.2) * 1200);
}

/** Deterministic +-`amp` HU texture so interpolation has something to interpolate. */
function noise(i: number, j: number, k: number, amp: number): number {
  let h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return ((h & 0xffff) / 0xffff - 0.5) * 2 * amp;
}

/**
 * Fill `volume` with a CT-like 3D Shepp-Logan phantom in HU, slice by slice
 * with scanline ellipse fills (fast enough for 10^8 voxels in well under a
 * second per hundred slices). `+y` of the phantom is anterior, so it maps to
 * decreasing j in an LPS grid.
 */
export function fillSheppLoganPhantom(volume: ScalarVolume, noiseHu = 8): void {
  const [nx, ny, nz] = volume.grid.dimensions;
  const acc = new Float32Array(nx * ny);
  const inside = new Uint8Array(nx * ny);
  for (let k = 0; k < nz; k++) {
    acc.fill(0);
    inside.fill(0);
    const z = nz === 1 ? 0 : (2 * k) / (nz - 1) - 1;
    for (let e = 0; e < SHEPP_LOGAN_3D.length; e++) {
      const el = SHEPP_LOGAN_3D[e]!;
      const dz = (z - el.z0) / el.c;
      if (dz * dz >= 1) continue;
      const shrink = Math.sqrt(1 - dz * dz);
      const A = el.a * shrink;
      const B = el.b * shrink;
      const phi = (el.phiDeg * Math.PI) / 180;
      const cs = Math.cos(phi);
      const sn = Math.sin(phi);
      const alpha = (cs * cs) / (A * A) + (sn * sn) / (B * B);
      const betaK = 2 * cs * sn * (1 / (A * A) - 1 / (B * B));
      const gammaK = (sn * sn) / (A * A) + (cs * cs) / (B * B);
      for (let j = 0; j < ny; j++) {
        const y = -((2 * j) / (ny - 1) - 1) - el.y0;
        const beta = betaK * y;
        const gamma = gammaK * y * y - 1;
        const disc = beta * beta - 4 * alpha * gamma;
        if (disc <= 0) continue;
        const root = Math.sqrt(disc);
        const xl = (-beta - root) / (2 * alpha) + el.x0;
        const xr = (-beta + root) / (2 * alpha) + el.x0;
        const il = Math.max(0, Math.ceil(((xl + 1) * (nx - 1)) / 2));
        const ir = Math.min(nx - 1, Math.floor(((xr + 1) * (nx - 1)) / 2));
        const row = j * nx;
        for (let i = il; i <= ir; i++) {
          acc[row + i] = acc[row + i]! + el.value;
          if (e === 0) inside[row + i] = 1;
        }
      }
    }
    const slice = volume.slices[k]!;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const o = j * nx + i;
        const isIn = inside[o] === 1;
        slice[o] = toHu(acc[o]!, isIn) + (isIn ? Math.round(noise(i, j, k, noiseHu)) : 0);
      }
    }
  }
}
