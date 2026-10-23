import type { GrayscaleRaster } from '@osdlabel/pixel';

/**
 * Synthetic test images. Everything is generated deterministically in the
 * browser (or in Node for the unit tests): no image file is committed and no
 * patient data is involved.
 */

/** Small, fast, seeded PRNG (mulberry32). */
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

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Ellipse {
  readonly x0: number;
  readonly y0: number;
  readonly a: number;
  readonly b: number;
  readonly thetaDeg: number;
  readonly hu: number;
}

/**
 * Shepp-Logan geometry with absolute CT numbers (HU) chosen so each standard
 * window has something to show: bone (+1500) for the bone window, CSF (+8)
 * vs grey matter (+38) vs small lesions a few HU apart for the brain window,
 * a subdural crescent (+75) for the subdural window, air (-1000) and a
 * lung-like region (-850..-650) for the lung window, and one +3000 HU
 * calcification so the range spans exactly -1000..+3000.
 */
const HEAD: readonly Ellipse[] = [
  { x0: 0, y0: 0, a: 0.69, b: 0.92, thetaDeg: 0, hu: 1500 }, // skull
  { x0: 0, y0: -0.0184, a: 0.6624, b: 0.874, thetaDeg: 0, hu: 75 }, // subdural layer
  { x0: 0.01, y0: -0.0184, a: 0.64, b: 0.85, thetaDeg: 0, hu: 30 }, // brain (white matter)
  { x0: 0.22, y0: 0, a: 0.11, b: 0.31, thetaDeg: -18, hu: 8 }, // ventricle (CSF)
  { x0: -0.22, y0: 0, a: 0.16, b: 0.41, thetaDeg: 18, hu: 8 }, // ventricle (CSF)
  { x0: 0, y0: 0.35, a: 0.21, b: 0.25, thetaDeg: 0, hu: 38 }, // grey matter
  { x0: 0, y0: 0.1, a: 0.046, b: 0.046, thetaDeg: 0, hu: 42 }, // lesion, +4 HU
  { x0: 0, y0: -0.1, a: 0.046, b: 0.046, thetaDeg: 0, hu: 26 }, // lesion, -4 HU
  { x0: -0.08, y0: -0.605, a: 0.046, b: 0.023, thetaDeg: 0, hu: 50 },
  { x0: 0, y0: -0.606, a: 0.023, b: 0.023, thetaDeg: 0, hu: 34 },
  { x0: 0.06, y0: -0.605, a: 0.023, b: 0.046, thetaDeg: 0, hu: 46 },
  { x0: 0.45, y0: 0.6, a: 0.08, b: 0.12, thetaDeg: 30, hu: -750 }, // sinus air / lung-like
  { x0: 0.12, y0: 0.62, a: 0.012, b: 0.012, thetaDeg: 0, hu: 3000 }, // calcification
];

const HEAD_MIN = -1000;
const HEAD_MAX = 3000;

/**
 * A `size x size` CT head phantom in HU (Int16, rescale identity). Adds a
 * +-4 HU low-frequency gradient across the brain and 2 HU Gaussian noise in
 * soft tissue, so smooth gradients exist for banding to show up in.
 */
export function ctHeadPhantom(size = 512, seed = 1): GrayscaleRaster {
  const data = new Int16Array(size * size);
  const rand = mulberry32(seed);
  const shapes = HEAD.map((e) => ({
    ...e,
    cos: Math.cos((e.thetaDeg * Math.PI) / 180),
    sin: Math.sin((e.thetaDeg * Math.PI) / 180),
  }));
  for (let j = 0; j < size; j++) {
    const y = (2 * (j + 0.5)) / size - 1;
    for (let i = 0; i < size; i++) {
      const x = (2 * (i + 0.5)) / size - 1;
      let hu = HEAD_MIN;
      for (const e of shapes) {
        const dx = x - e.x0;
        const dy = y - e.y0;
        const u = dx * e.cos + dy * e.sin;
        const v = -dx * e.sin + dy * e.cos;
        if ((u * u) / (e.a * e.a) + (v * v) / (e.b * e.b) <= 1) hu = e.hu;
      }
      if (hu > -200 && hu < 200) {
        hu += 4 * Math.sin(x * 2.1) * Math.cos(y * 1.3) + 2 * gaussian(rand);
      } else if (hu > -900 && hu < -500) {
        hu += 100 * Math.sin(x * 9) * Math.sin(y * 7) + 10 * gaussian(rand);
      }
      data[j * size + i] = Math.max(HEAD_MIN, Math.min(HEAD_MAX, Math.round(hu)));
    }
  }
  return { width: size, height: size, data };
}

/**
 * Every integer from `min` to `max` exactly once (the rest of the square
 * clamped to `max`), laid out row-major on a `side x side` grid. Displayed
 * magnified with nearest-neighbour sampling, each block's colour is the
 * pipeline's output for exactly one input value: the pixel-level check of H1.
 */
export function valueRamp(min = HEAD_MIN, max = HEAD_MAX): GrayscaleRaster {
  const count = max - min + 1;
  const side = Math.ceil(Math.sqrt(count));
  const data = new Int16Array(side * side);
  for (let k = 0; k < data.length; k++) data[k] = Math.min(max, min + k);
  return { width: side, height: side, data };
}

/** Value noise: a seeded `cells x cells` lattice, bilinearly interpolated. */
function valueNoise(cells: number, seed: number): (u: number, v: number) => number {
  const rand = mulberry32(seed);
  const n = cells + 1;
  const lattice = new Float32Array(n * n);
  for (let k = 0; k < lattice.length; k++) lattice[k] = rand() * 2 - 1;
  return (u: number, v: number): number => {
    const fx = u * cells;
    const fy = v * cells;
    const x0 = Math.min(cells - 1, Math.floor(fx));
    const y0 = Math.min(cells - 1, Math.floor(fy));
    const tx = fx - x0;
    const ty = fy - y0;
    const a = lattice[y0 * n + x0]!;
    const b = lattice[y0 * n + x0 + 1]!;
    const c = lattice[(y0 + 1) * n + x0]!;
    const d = lattice[(y0 + 1) * n + x0 + 1]!;
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

/**
 * A 16-bit (Uint16, full 0..65535 range used) mammography-like image:
 * a breast outline against the left edge, a smooth density ramp from skin to
 * chest wall, multi-octave fibroglandular texture a few hundred units deep,
 * a subtle mass (+600) and microcalcifications (+8000, 2-3 px). The default
 * size is a typical full-field digital mammogram, 4096 x 3328.
 */
export function mammoPhantom(width = 4096, height = 3328, seed = 7): GrayscaleRaster {
  const data = new Uint16Array(width * height);
  const octaves = [
    { f: valueNoise(6, seed), amp: 2600 },
    { f: valueNoise(24, seed + 1), amp: 900 },
    { f: valueNoise(96, seed + 2), amp: 300 },
    { f: valueNoise(384, seed + 3), amp: 90 },
  ];
  const rand = mulberry32(seed + 9);
  const cy = height / 2;
  const rx = width * 0.82;
  const ry = height * 0.47;
  const massX = width * 0.42;
  const massY = height * 0.44;
  const massR = Math.min(width, height) * 0.035;
  for (let j = 0; j < height; j++) {
    const v = j / height;
    const dy = (j - cy) / ry;
    for (let i = 0; i < width; i++) {
      const dx = i / rx;
      const r2 = dx * dx + dy * dy;
      let value: number;
      if (r2 > 1) {
        value = 900 + 40 * octaves[3]!.f(i / width, v);
      } else {
        const depth = 1 - Math.sqrt(r2); // 0 at the skin line, 1 at the chest wall
        const u = i / width;
        let tex = 0;
        for (const o of octaves) tex += o.amp * o.f(u, v);
        value = 18000 + 26000 * Math.pow(depth, 0.6) + tex * Math.min(1, depth * 4);
        const mx = (i - massX) / massR;
        const my = (j - massY) / massR;
        value += 600 * Math.exp(-(mx * mx + my * my));
      }
      data[j * width + i] = Math.max(0, Math.min(65535, Math.round(value)));
    }
  }
  // Microcalcification cluster.
  for (let k = 0; k < 40; k++) {
    const x = Math.round(width * 0.3 + rand() * 120);
    const y = Math.round(height * 0.6 + rand() * 120);
    const r = 1 + Math.round(rand());
    for (let yy = -r; yy <= r; yy++) {
      for (let xx = -r; xx <= r; xx++) {
        const idx = (y + yy) * width + (x + xx);
        if (idx >= 0 && idx < data.length) data[idx] = Math.min(65535, data[idx]! + 8000);
      }
    }
  }
  return { width, height, data };
}

/**
 * The 8-bit image a conventional tile pipeline would serve: full-range linear
 * quantisation of the stored values, as opaque grey RGBA.
 */
export function quantizeToRgba8(
  raster: GrayscaleRaster,
  min: number,
  max: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(raster.width * raster.height * 4);
  const scale = 255 / (max - min);
  for (let k = 0; k < raster.data.length; k++) {
    const g = Math.round((raster.data[k]! - min) * scale);
    const o = k * 4;
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
  return out;
}
