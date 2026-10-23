import {
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  emptySnapshot,
  type MaskSnapshot,
} from '@osdlabel/mask';
import {
  assembleHoles,
  signedArea,
  simplifyRing,
  traceIsoContours,
  tracePixelContours,
  transformRing,
  type PolygonWithHoles,
  type Ring,
} from '@osdlabel/mask-contour';
import type { ImageRegion, ImageSize, MaskCandidate, RasterMask } from './types.js';

const isLogits = (d: Float32Array | Uint8Array): d is Float32Array => d instanceof Float32Array;

/**
 * SAM's stability score: IoU between the mask thresholded at `threshold +
 * offset` and at `threshold - offset`. Near 1 means the boundary sits on a
 * steep logit edge; low values flag a mask whose extent is a coin toss.
 */
export function stabilityScore(raster: RasterMask, threshold = 0, offset = 1): number {
  const d = raster.data;
  if (!isLogits(d)) return 1;
  let inner = 0;
  let outer = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!;
    if (v > threshold + offset) inner++;
    if (v > threshold - offset) outer++;
  }
  return outer === 0 ? 0 : inner / outer;
}

export type CandidateRanking = 'iou' | 'stability' | 'iou-x-stability';

/** Candidates best first under `ranking`; stability is computed when missing. */
export function rankCandidates(
  candidates: readonly MaskCandidate[],
  ranking: CandidateRanking = 'iou',
): MaskCandidate[] {
  const scored = candidates.map((c) => ({
    ...c,
    stability: c.stability ?? stabilityScore(c.mask),
  }));
  const key = (c: MaskCandidate & { stability: number }): number =>
    ranking === 'iou'
      ? c.predictedIou
      : ranking === 'stability'
        ? c.stability
        : c.predictedIou * c.stability;
  return scored.sort((a, b) => key(b) - key(a));
}

/** Grid-space bounds of foreground samples, or null when empty. */
function foregroundCells(raster: RasterMask, threshold: number) {
  const { width, height } = raster.frame;
  const d = raster.data;
  let u0 = width;
  let v0 = height;
  let u1 = -1;
  let v1 = -1;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const val = d[v * width + u]!;
      if (isLogits(d) ? val > threshold : val !== 0) {
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
    }
  }
  return u1 < 0 ? null : { u0, v0, u1, v1 };
}

/**
 * Image-space bounding box the mask can occupy. With logits the bilinear
 * field can spill up to one grid cell past the outermost foreground sample.
 */
export function rasterImageBounds(
  raster: RasterMask,
  imageSize: ImageSize,
  threshold = 0,
): ImageRegion | null {
  const cells = foregroundCells(raster, threshold);
  if (!cells) return null;
  const f = raster.frame;
  const spill = isLogits(raster.data) ? 0.5 : 0;
  const x0 = Math.max(0, Math.floor(f.originX + (cells.u0 - spill) * f.pixelWidth));
  const y0 = Math.max(0, Math.floor(f.originY + (cells.v0 - spill) * f.pixelHeight));
  const x1 = Math.min(imageSize.width, Math.ceil(f.originX + (cells.u1 + 1 + spill) * f.pixelWidth));
  const y1 = Math.min(imageSize.height, Math.ceil(f.originY + (cells.v1 + 1 + spill) * f.pixelHeight));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface RasterToSnapshotOptions {
  readonly threshold?: number | undefined;
  /** Refuse (throw) rather than allocate more than this. Default `DEFAULT_MAX_MASK_PIXELS`. */
  readonly maxPixels?: number | undefined;
}

/**
 * Resamples a provider raster into a full-resolution `@osdlabel/mask`
 * snapshot: bilinear on logits (what SAM's own postprocessing does), nearest
 * on binary data. Cost and memory scale with the mask's bounding box in
 * *image* pixels — the reason a coarse encode on a gigapixel image can exceed
 * the mask cap even though the model output is only 256x256.
 */
export function rasterToMaskSnapshot(
  raster: RasterMask,
  imageSize: ImageSize,
  options?: RasterToSnapshotOptions,
): MaskSnapshot {
  const threshold = options?.threshold ?? 0;
  const maxPixels = options?.maxPixels ?? DEFAULT_MAX_MASK_PIXELS;
  const box = rasterImageBounds(raster, imageSize, threshold);
  if (!box) return emptySnapshot(imageSize.width, imageSize.height);
  const area = box.width * box.height;
  if (area > maxPixels) throw new MaskCapacityExceededError(area, maxPixels);

  const f = raster.frame;
  const src = raster.data;
  const W = f.width;
  const H = f.height;
  const out = new Uint8Array(area);

  if (isLogits(src)) {
    const ui0 = new Int32Array(box.width);
    const ui1 = new Int32Array(box.width);
    const fu = new Float32Array(box.width);
    for (let c = 0; c < box.width; c++) {
      const u = (box.x + c + 0.5 - f.originX) / f.pixelWidth - 0.5;
      const u0 = Math.floor(u);
      fu[c] = u - u0;
      ui0[c] = Math.min(W - 1, Math.max(0, u0));
      ui1[c] = Math.min(W - 1, Math.max(0, u0 + 1));
    }
    for (let r = 0; r < box.height; r++) {
      const v = (box.y + r + 0.5 - f.originY) / f.pixelHeight - 0.5;
      const v0 = Math.floor(v);
      const fv = v - v0;
      const row0 = Math.min(H - 1, Math.max(0, v0)) * W;
      const row1 = Math.min(H - 1, Math.max(0, v0 + 1)) * W;
      const o = r * box.width;
      for (let c = 0; c < box.width; c++) {
        const a = src[row0 + ui0[c]!]!;
        const b = src[row0 + ui1[c]!]!;
        const cc = src[row1 + ui0[c]!]!;
        const d = src[row1 + ui1[c]!]!;
        const t = fu[c]!;
        const top = a + (b - a) * t;
        const bottom = cc + (d - cc) * t;
        if (top + (bottom - top) * fv > threshold) out[o + c] = 1;
      }
    }
  } else {
    for (let r = 0; r < box.height; r++) {
      const v = Math.floor((box.y + r + 0.5 - f.originY) / f.pixelHeight);
      if (v < 0 || v >= H) continue;
      const o = r * box.width;
      for (let c = 0; c < box.width; c++) {
        const u = Math.floor((box.x + c + 0.5 - f.originX) / f.pixelWidth);
        if (u >= 0 && u < W && src[v * W + u] !== 0) out[o + c] = 1;
      }
    }
  }
  return tighten(
    {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      data: out,
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
    },
  );
}

/** Crops a snapshot to the exact bounding box of its set pixels. */
export function tighten(s: MaskSnapshot): MaskSnapshot {
  let x0 = s.width;
  let y0 = s.height;
  let x1 = -1;
  let y1 = -1;
  for (let r = 0; r < s.height; r++) {
    const o = r * s.width;
    for (let c = 0; c < s.width; c++) {
      if (s.data[o + c] === 1) {
        if (c < x0) x0 = c;
        if (c > x1) x1 = c;
        if (r < y0) y0 = r;
        if (r > y1) y1 = r;
      }
    }
  }
  if (x1 < 0) return emptySnapshot(s.imageWidth, s.imageHeight);
  if (x0 === 0 && y0 === 0 && x1 === s.width - 1 && y1 === s.height - 1) return s;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    data.set(s.data.subarray((y0 + r) * s.width + x0, (y0 + r) * s.width + x0 + w), r * w);
  }
  return { ...s, x: s.x + x0, y: s.y + y0, width: w, height: h, data };
}

export interface RasterToPolygonsOptions {
  readonly threshold?: number | undefined;
  /** Douglas–Peucker tolerance in image pixels. Default: half a raster pixel. */
  readonly tolerance?: number | undefined;
  /** Drop rings smaller than this many image pixels². Default: one raster pixel. */
  readonly minArea?: number | undefined;
}

/**
 * Vectorises a provider raster directly at its native resolution: iso-contours
 * of the logits (sub-pixel, smooth) or pixel-edge contours of binary data,
 * then mapped to image space and simplified. Cost is proportional to the
 * raster (256x256 for SAM), independent of how many image pixels it covers.
 */
export function rasterToPolygons(raster: RasterMask, options?: RasterToPolygonsOptions): PolygonWithHoles[] {
  const f = raster.frame;
  const threshold = options?.threshold ?? 0;
  const cellArea = f.pixelWidth * f.pixelHeight;
  const tolerance = options?.tolerance ?? 0.5 * Math.min(f.pixelWidth, f.pixelHeight);
  const minArea = options?.minArea ?? cellArea;
  const grid = { width: f.width, height: f.height, data: raster.data };
  const contours = isLogits(raster.data)
    ? traceIsoContours({ ...grid, data: raster.data }, threshold)
    : tracePixelContours({ ...grid, data: raster.data as Uint8Array });
  const mapped = contours
    .map((c) => {
      const ring: Ring = transformRing(c.ring, f.pixelWidth, f.pixelHeight, f.originX, f.originY);
      return { ring: simplifyRing(ring, tolerance), hole: c.hole };
    })
    .filter((c) => c.ring.length >= 3 && Math.abs(signedArea(c.ring)) >= minArea);
  return assembleHoles(mapped);
}
