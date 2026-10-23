/**
 * A procedural ultrasound-like cine loop: a B-mode sector with Rayleigh
 * speckle that moves with the "tissue", depth attenuation, and a pulsating
 * dark chamber with a bright wall — enough structure that per-frame
 * annotations (a chamber outline, a caliper across it) are meaningful and
 * actually move. RGBA output, a slight warm tint, frame barcode stamped.
 * Pure: runs anywhere.
 */
import { mulberry32 } from './ct-phantom.js';
import { stampFrameMarker } from './marker.js';

export interface UltrasoundGeometry {
  readonly width: number;
  readonly height: number;
  readonly apexX: number;
  readonly apexY: number;
  readonly rMin: number;
  readonly rMax: number;
  readonly halfAngle: number;
}

export function ultrasoundGeometry(width: number, height: number): UltrasoundGeometry {
  return {
    width,
    height,
    apexX: width / 2,
    apexY: height * 0.05,
    rMin: height * 0.1,
    rMax: height * 0.93,
    halfAngle: 0.75,
  };
}

const R_BINS = 512;
const T_BINS = 256;

interface Lut {
  readonly geom: UltrasoundGeometry;
  /** Per pixel: r bin, or -1 outside the sector. */
  readonly rBin: Int16Array;
  readonly tBin: Uint8Array;
  readonly atten: Float32Array;
  readonly speckle: Float32Array;
}

function buildLut(geom: UltrasoundGeometry): Lut {
  const { width, height } = geom;
  const rBin = new Int16Array(width * height).fill(-1);
  const tBin = new Uint8Array(width * height);
  const atten = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - geom.apexX;
      const dy = y - geom.apexY;
      const r = Math.sqrt(dx * dx + dy * dy);
      const t = Math.atan2(dx, dy);
      if (r < geom.rMin || r > geom.rMax || Math.abs(t) > geom.halfAngle) continue;
      const i = y * width + x;
      rBin[i] = Math.min(
        R_BINS - 1,
        Math.floor(((r - geom.rMin) / (geom.rMax - geom.rMin)) * R_BINS),
      );
      tBin[i] = Math.min(
        T_BINS - 1,
        Math.floor(((t + geom.halfAngle) / (2 * geom.halfAngle)) * T_BINS),
      );
      atten[i] = Math.exp(-r / (geom.height * 1.4));
    }
  }
  const rnd = mulberry32(99);
  const speckle = new Float32Array(R_BINS * T_BINS * 2);
  for (let i = 0; i < speckle.length; i++) {
    speckle[i] = Math.sqrt(-2 * Math.log(Math.max(1e-6, rnd()))) * 0.6;
  }
  return { geom, rBin, tBin, atten, speckle };
}

let cached: Lut | undefined;
function lutFor(width: number, height: number): Lut {
  if (!cached || cached.geom.width !== width || cached.geom.height !== height) {
    cached = buildLut(ultrasoundGeometry(width, height));
  }
  return cached;
}

/** The chamber's ellipse on frame `index` (image pixels). */
export function chamberAt(
  index: number,
  width: number,
  height: number,
): { cx: number; cy: number; rx: number; ry: number } {
  const phase = (2 * Math.PI * index) / 25;
  return {
    cx: width / 2 + 10 * Math.sin((2 * Math.PI * index) / 50),
    cy: height * 0.5,
    rx: width * 0.11 + width * 0.03 * Math.sin(phase),
    ry: height * 0.1 + height * 0.025 * Math.sin(phase),
  };
}

/** Render frame `index` into `out` (RGBA, width*height*4). */
export function renderUltrasoundFrame(
  index: number,
  width: number,
  height: number,
  out: Uint8ClampedArray,
): Uint8ClampedArray {
  const lut = lutFor(width, height);
  const shift = Math.round(6 * Math.sin((2 * Math.PI * index) / 50) + index * 0.5);
  const ch = chamberAt(index, width, height);
  const wall = 0.18;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const rb = lut.rBin[i] ?? -1;
      if (rb < 0) {
        out[p] = out[p + 1] = out[p + 2] = 0;
        out[p + 3] = 255;
        continue;
      }
      const tb = lut.tBin[i] ?? 0;
      const s = lut.speckle[((rb + shift) & (R_BINS * 2 - 1)) * T_BINS + tb] ?? 0;
      let v = s * (lut.atten[i] ?? 0) * 255;
      const ex = (x - ch.cx) / ch.rx;
      const ey = (y - ch.cy) / ch.ry;
      const d = ex * ex + ey * ey;
      if (d < 1) v *= 0.12;
      else if (d < 1 + wall) v = v * 1.6 + 60;
      const g = v > 255 ? 255 : v;
      out[p] = g;
      out[p + 1] = g * 0.95;
      out[p + 2] = g * 0.82;
      out[p + 3] = 255;
    }
  }
  stampFrameMarker(out, width, 4, index);
  return out;
}
