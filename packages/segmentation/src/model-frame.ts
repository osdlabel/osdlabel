import type { Point } from '@osdlabel/annotation';
import type { EncodeView, RasterFrame } from './types.js';

/**
 * How an encode view maps onto a square model input.
 *
 * - `letterbox` (SAM, MobileSAM, EdgeSAM, LiteMedSAM): the longer side fills
 *   the input, aspect is preserved, padding goes bottom/right.
 * - `stretch` (SAM 2, EfficientSAM): the region is resized to the full square,
 *   so x and y scales differ for non-square regions.
 */
export type InputLayout = 'letterbox' | 'stretch';

export interface ModelFrame {
  readonly view: EncodeView;
  readonly inputSize: number;
  readonly layout: InputLayout;
  /** Model-input pixels the region's pixels fill; the rest is padding. */
  readonly contentWidth: number;
  readonly contentHeight: number;
  /** Model pixels per image pixel, per axis. */
  readonly scaleX: number;
  readonly scaleY: number;
}

export function modelFrame(view: EncodeView, inputSize: number, layout: InputLayout): ModelFrame {
  const { width, height } = view.region;
  if (layout === 'stretch') {
    return {
      view,
      inputSize,
      layout,
      contentWidth: inputSize,
      contentHeight: inputSize,
      scaleX: inputSize / width,
      scaleY: inputSize / height,
    };
  }
  const contentWidth = Math.max(1, Math.min(inputSize, Math.round(width * view.scale)));
  const contentHeight = Math.max(1, Math.min(inputSize, Math.round(height * view.scale)));
  return {
    view,
    inputSize,
    layout,
    contentWidth,
    contentHeight,
    scaleX: contentWidth / width,
    scaleY: contentHeight / height,
  };
}

export function imageToModel(frame: ModelFrame, p: Point): Point {
  return {
    x: (p.x - frame.view.region.x) * frame.scaleX,
    y: (p.y - frame.view.region.y) * frame.scaleY,
  };
}

export function modelToImage(frame: ModelFrame, p: Point): Point {
  return {
    x: frame.view.region.x + p.x / frame.scaleX,
    y: frame.view.region.y + p.y / frame.scaleY,
  };
}

/**
 * The placement of a `gridSize x gridSize` model output (SAM's 256x256
 * low-res logits cover the whole padded input) cropped to the content area.
 * The returned frame's `width`/`height` are the cropped grid size; callers
 * copy rows `0..height` and columns `0..width` of the model output.
 */
export function modelGridFrame(frame: ModelFrame, gridSize: number): RasterFrame {
  const cell = frame.inputSize / gridSize; // model px per grid px
  return {
    originX: frame.view.region.x,
    originY: frame.view.region.y,
    pixelWidth: cell / frame.scaleX,
    pixelHeight: cell / frame.scaleY,
    width: Math.min(gridSize, Math.ceil(frame.contentWidth / cell)),
    height: Math.min(gridSize, Math.ceil(frame.contentHeight / cell)),
  };
}

/** Copies the top-left `frame.width x frame.height` window out of a square model plane. */
export function cropGrid(plane: Float32Array, gridSize: number, frame: RasterFrame): Float32Array {
  if (frame.width === gridSize && frame.height === gridSize)
    return plane.slice(0, gridSize * gridSize);
  const out = new Float32Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y++) {
    out.set(plane.subarray(y * gridSize, y * gridSize + frame.width), y * frame.width);
  }
  return out;
}

/**
 * Resamples logits onto another grid (bilinear at each target cell centre, in
 * image space). Cells outside the source's extent get `outside` (default: the
 * source's smallest value, i.e. its most confident background).
 */
export function resampleLogits(
  src: Float32Array,
  from: RasterFrame,
  to: RasterFrame,
  outside?: number,
): Float32Array {
  let fill = outside;
  if (fill === undefined) {
    fill = Infinity;
    for (let i = 0; i < src.length; i++) fill = Math.min(fill, src[i]!);
    if (fill === Infinity) fill = 0;
  }
  const out = new Float32Array(to.width * to.height);
  const W = from.width;
  const H = from.height;
  for (let v = 0; v < to.height; v++) {
    const y = to.originY + (v + 0.5) * to.pixelHeight;
    const fv = (y - from.originY) / from.pixelHeight - 0.5;
    for (let u = 0; u < to.width; u++) {
      const x = to.originX + (u + 0.5) * to.pixelWidth;
      const fu = (x - from.originX) / from.pixelWidth - 0.5;
      if (fu < -0.5 || fv < -0.5 || fu > W - 0.5 || fv > H - 0.5) {
        out[v * to.width + u] = fill;
        continue;
      }
      const u0 = Math.floor(fu);
      const v0 = Math.floor(fv);
      const tu = fu - u0;
      const tv = fv - v0;
      const cu0 = Math.min(W - 1, Math.max(0, u0));
      const cu1 = Math.min(W - 1, Math.max(0, u0 + 1));
      const r0 = Math.min(H - 1, Math.max(0, v0)) * W;
      const r1 = Math.min(H - 1, Math.max(0, v0 + 1)) * W;
      const top = src[r0 + cu0]! + (src[r0 + cu1]! - src[r0 + cu0]!) * tu;
      const bottom = src[r1 + cu0]! + (src[r1 + cu1]! - src[r1 + cu0]!) * tu;
      out[v * to.width + u] = top + (bottom - top) * tv;
    }
  }
  return out;
}

/**
 * Whether two rasters share one grid: same origin, cell size and dimensions
 * (to a relative 1e-9, since the frames are computed in floating point).
 * A SAM `mask_input` is only meaningful on the grid of the embedding it is
 * decoded with; after a re-encode the previous logits sit on another grid.
 */
export function sameRasterFrame(a: RasterFrame, b: RasterFrame): boolean {
  const close = (p: number, q: number): boolean =>
    Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p), Math.abs(q));
  return (
    a.width === b.width &&
    a.height === b.height &&
    close(a.originX, b.originX) &&
    close(a.originY, b.originY) &&
    close(a.pixelWidth, b.pixelWidth) &&
    close(a.pixelHeight, b.pixelHeight)
  );
}
