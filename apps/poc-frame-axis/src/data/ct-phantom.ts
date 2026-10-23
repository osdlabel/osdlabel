/**
 * A procedural CT-like phantom: a 3D Shepp–Logan-style set of ellipsoids
 * sliced along z, with deterministic noise. 8-bit display data (windowing is
 * another PoC's subject). Pure: runs in a worker, the page or Node.
 *
 * Each slice also carries a 9-bit barcode of its own index in the top-left
 * corner (see `marker.ts`) so a pixel readback can prove which slice a
 * renderer actually put on screen.
 */
import { stampFrameMarker } from './marker.js';

interface Ellipsoid {
  /** Centre and semi-axes in normalised volume units: x,y in [-1,1], z in [0,1]. */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  /** Intensity added inside (can be negative). */
  readonly value: number;
}

/** Body, skull ring, organs and three small "lesions" that live on a few slices each. */
export const PHANTOM: readonly Ellipsoid[] = [
  { cx: 0, cy: 0, cz: 0.5, a: 0.9, b: 0.75, c: 0.62, value: 90 },
  { cx: 0, cy: 0, cz: 0.5, a: 0.86, b: 0.71, c: 0.6, value: 120 },
  { cx: 0, cy: 0, cz: 0.5, a: 0.8, b: 0.66, c: 0.58, value: -120 },
  { cx: -0.32, cy: -0.05, cz: 0.45, a: 0.22, b: 0.34, c: 0.3, value: 35 },
  { cx: 0.32, cy: -0.05, cz: 0.55, a: 0.22, b: 0.34, c: 0.3, value: 35 },
  { cx: 0, cy: 0.38, cz: 0.5, a: 0.18, b: 0.12, c: 0.35, value: 55 },
  { cx: 0.05, cy: -0.4, cz: 0.4, a: 0.1, b: 0.08, c: 0.12, value: 70 },
  { cx: -0.3, cy: 0.1, cz: 0.3, a: 0.05, b: 0.05, c: 0.05, value: 100 },
  { cx: 0.25, cy: 0.2, cz: 0.62, a: 0.04, b: 0.06, c: 0.04, value: 100 },
  { cx: 0.1, cy: 0.05, cz: 0.75, a: 0.07, b: 0.05, c: 0.06, value: 100 },
];

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE_SIZE = 1 << 16;
let noiseTable: Int8Array | undefined;
function noise(): Int8Array {
  if (!noiseTable) {
    const rnd = mulberry32(1234);
    noiseTable = new Int8Array(NOISE_SIZE);
    for (let i = 0; i < NOISE_SIZE; i++) noiseTable[i] = Math.round((rnd() - 0.5) * 18);
  }
  return noiseTable;
}

/**
 * Render slice `index` of `count` into `out` (width*height, 8-bit gray).
 * Scanline fill per ellipsoid, so cost is O(pixels + rows * ellipsoids).
 */
export function renderCtSlice(
  index: number,
  count: number,
  width: number,
  height: number,
  out: Uint8Array,
): Uint8Array {
  const acc = new Int16Array(width * height);
  const z = count <= 1 ? 0.5 : index / (count - 1);
  const sx = width / 2;
  const sy = height / 2;
  for (const e of PHANTOM) {
    const dz = (z - e.cz) / e.c;
    if (dz * dz >= 1) continue;
    const scale = Math.sqrt(1 - dz * dz);
    const a = e.a * scale * sx;
    const b = e.b * scale * sy;
    const cx = (e.cx + 1) * sx;
    const cy = (e.cy + 1) * sy;
    const y0 = Math.max(0, Math.ceil(cy - b));
    const y1 = Math.min(height - 1, Math.floor(cy + b));
    for (let y = y0; y <= y1; y++) {
      const dy = (y - cy) / b;
      const half = a * Math.sqrt(Math.max(0, 1 - dy * dy));
      const x0 = Math.max(0, Math.ceil(cx - half));
      const x1 = Math.min(width - 1, Math.floor(cx + half));
      const row = y * width;
      for (let x = x0; x <= x1; x++) acc[row + x] = (acc[row + x] ?? 0) + e.value;
    }
  }
  const n = noise();
  const shift = (index * 7919) & (NOISE_SIZE - 1);
  for (let i = 0; i < acc.length; i++) {
    const v = (acc[i] ?? 0) + (n[(i + shift) & (NOISE_SIZE - 1)] ?? 0);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  stampFrameMarker(out, width, 1, index);
  return out;
}

/** All slices as one contiguous buffer (count * width * height bytes). */
export function renderCtStack(count: number, width: number, height: number): Uint8Array {
  const all = new Uint8Array(count * width * height);
  for (let i = 0; i < count; i++) {
    renderCtSlice(
      i,
      count,
      width,
      height,
      all.subarray(i * width * height, (i + 1) * width * height),
    );
  }
  return all;
}

/**
 * Where the phantom's lesions sit on slice `index`, in image pixels — used to
 * place fixture annotations on structures that exist on that slice.
 */
export function lesionsOnSlice(
  index: number,
  count: number,
  width: number,
  height: number,
): { x: number; y: number; r: number }[] {
  const z = count <= 1 ? 0.5 : index / (count - 1);
  const out: { x: number; y: number; r: number }[] = [];
  for (const e of PHANTOM.slice(6)) {
    const dz = (z - e.cz) / e.c;
    if (dz * dz >= 1) continue;
    const s = Math.sqrt(1 - dz * dz);
    out.push({
      x: (e.cx + 1) * (width / 2),
      y: (e.cy + 1) * (height / 2),
      r: Math.max(e.a * (width / 2), e.b * (height / 2)) * s,
    });
  }
  return out;
}
