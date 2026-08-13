import type { Point } from '@osdlabel/annotation';

/**
 * A letterbox transform mapping image-space pixels to a square model input of
 * side `inputSize`: scale by `scale` (longest-side fit, aspect preserved) then
 * translate by `(offsetX, offsetY)` padding. Needed client-side so a decoder can
 * map prompt coordinates into the same frame the encoder used, and map mask
 * coordinates back to image space.
 */
export interface ResizeTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly inputSize: number;
}

export interface ComputeResizeTransformOptions {
  /** Padding placement once the longest side is scaled to fit. Default `'top-left'` (SAM-style). */
  readonly pad?: 'top-left' | 'center';
}

/**
 * Computes the letterbox transform that fits a `srcWidth × srcHeight` image into
 * an `inputSize × inputSize` square, preserving aspect ratio.
 */
export function computeResizeTransform(
  srcWidth: number,
  srcHeight: number,
  inputSize: number,
  options?: ComputeResizeTransformOptions,
): ResizeTransform {
  const scale = inputSize / Math.max(srcWidth, srcHeight);
  if (options?.pad === 'center') {
    return {
      scale,
      offsetX: (inputSize - srcWidth * scale) / 2,
      offsetY: (inputSize - srcHeight * scale) / 2,
      inputSize,
    };
  }
  return { scale, offsetX: 0, offsetY: 0, inputSize };
}

/** Maps an image-space point into model-input space. */
export function imageToModel(p: Point, t: ResizeTransform): Point {
  return { x: p.x * t.scale + t.offsetX, y: p.y * t.scale + t.offsetY };
}

/** Maps a model-input-space point back into image space. */
export function modelToImage(p: Point, t: ResizeTransform): Point {
  return { x: (p.x - t.offsetX) / t.scale, y: (p.y - t.offsetY) / t.scale };
}
