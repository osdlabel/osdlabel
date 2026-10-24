import type { EncodeView, ImageRegion, SegmentationPrompt } from './types.js';
import type { SegmentationTarget } from './provider.js';

/**
 * How a crop-based provider turns "what the user sees" into "what to encode",
 * and when an existing embedding still serves.
 */
export interface EncodePolicy {
  /** Model input side in pixels (SAM: 1024). */
  readonly inputSize: number;
  /**
   * Fraction of the viewport added on each side before encoding: context for
   * objects cut by the screen edge, and slack so small pans reuse the
   * embedding. Default 0.25.
   */
  readonly margin: number;
  /**
   * Finest encode, in model pixels per image pixel. 1 (default) means never
   * upsample the image: when zoomed past 1:1 the crop grows to `inputSize`
   * image pixels around the viewport instead.
   */
  readonly maxScale: number;
  /**
   * Reuse an embedding while the screen shows the image at most this many
   * times finer than the embedding (zooming in). Right after an encode the
   * ratio is already about (1 + 2 * margin) * viewportWidthPx / inputSize
   * (1.5 for a 1024 px viewport), so the default of 3 allows roughly a 2x zoom
   * before mask edges lag the image enough to justify a re-encode.
   */
  readonly maxZoomIn: number;
}

export const DEFAULT_ENCODE_POLICY: EncodePolicy = {
  inputSize: 1024,
  margin: 0.25,
  maxScale: 1,
  maxZoomIn: 3,
};

function clampRegion(r: ImageRegion, w: number, h: number): ImageRegion {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.width));
  const y1 = Math.min(h, Math.ceil(r.y + r.height));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Grows `r` to at least `size` along each axis, centred, shifted to stay inside the image. */
function growTo(r: ImageRegion, sizeX: number, sizeY: number, w: number, h: number): ImageRegion {
  const width = Math.min(w, Math.max(r.width, sizeX));
  const height = Math.min(h, Math.max(r.height, sizeY));
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const x = Math.min(Math.max(0, cx - width / 2), w - width);
  const y = Math.min(Math.max(0, cy - height / 2), h - height);
  return { x, y, width, height };
}

/**
 * The view to encode for `target`: the viewport plus a margin, clipped to the
 * image, at the scale that fits its longer side into the model input — but
 * never finer than `maxScale`, in which case the crop grows instead.
 */
export function planEncodeView(
  target: SegmentationTarget,
  policy: EncodePolicy = DEFAULT_ENCODE_POLICY,
): EncodeView {
  const { width: W, height: H } = target.imageSize;
  const v = target.viewport;
  const mx = v.width * policy.margin;
  const my = v.height * policy.margin;
  let region = clampRegion(
    { x: v.x - mx, y: v.y - my, width: v.width + 2 * mx, height: v.height + 2 * my },
    W,
    H,
  );
  const minSide = policy.inputSize / policy.maxScale;
  if (Math.max(region.width, region.height) < minSide) {
    // Zoomed past the finest scale: spend the spare model pixels on context.
    region = clampRegion(growTo(region, minSide, minSide, W, H), W, H);
  }
  const scale = Math.min(policy.maxScale, policy.inputSize / Math.max(region.width, region.height));
  return {
    imageKey: target.imageKey,
    ...(target.variant !== undefined ? { variant: target.variant } : {}),
    imageSize: target.imageSize,
    region,
    scale,
  };
}

function contains(outer: ImageRegion, inner: ImageRegion, tolerance: number): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Image-space bounds of a prompt, or null for an empty one. */
export function promptBounds(prompt: SegmentationPrompt): ImageRegion | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of prompt.points ?? []) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (prompt.box) {
    const b = prompt.box;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export type ReuseVerdict =
  | { readonly reuse: true }
  | {
      readonly reuse: false;
      readonly reason:
        | 'other-image'
        | 'other-variant'
        | 'panned-out'
        | 'prompt-outside'
        | 'too-coarse';
    };

/**
 * Whether an embedding of `view` can answer `prompt` for `target`.
 *
 * - The viewport must still lie inside the encoded region (allowing one
 *   embedding pixel of slack): pans within the margin reuse it.
 * - Every prompt point and the box must lie inside it: SAM cannot segment
 *   what it did not see.
 * - The screen must not show the image more than `maxZoomIn` times finer than
 *   the embedding resolves it. Zooming *out* never invalidates by resolution,
 *   but it does by coverage (the viewport outgrows the region).
 */
export function canReuse(
  view: EncodeView,
  target: SegmentationTarget,
  prompt: SegmentationPrompt | null,
  policy: EncodePolicy = DEFAULT_ENCODE_POLICY,
): ReuseVerdict {
  if (view.imageKey !== target.imageKey) return { reuse: false, reason: 'other-image' };
  if (view.variant !== target.variant) return { reuse: false, reason: 'other-variant' };
  const slack = 1 / view.scale;
  if (!contains(view.region, target.viewport, slack)) return { reuse: false, reason: 'panned-out' };
  if (prompt) {
    const pb = promptBounds(prompt);
    if (pb && !contains(view.region, pb, 0)) return { reuse: false, reason: 'prompt-outside' };
  }
  // viewportScale is screen px per image px; view.scale is model px per image px.
  if (target.viewportScale / view.scale > policy.maxZoomIn) {
    return { reuse: false, reason: 'too-coarse' };
  }
  return { reuse: true };
}
