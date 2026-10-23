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
  if (frame.width === gridSize && frame.height === gridSize) return plane.slice(0, gridSize * gridSize);
  const out = new Float32Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y++) {
    out.set(plane.subarray(y * gridSize, y * gridSize + frame.width), y * frame.width);
  }
  return out;
}
