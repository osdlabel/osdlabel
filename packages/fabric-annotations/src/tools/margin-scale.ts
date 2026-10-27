import type { MaskRegion } from '@osdlabel/mask';
import { MAX_MASK_CANVAS_PIXELS, MAX_MASK_CANVAS_SIDE } from '../mask-canvas-limit.js';

/**
 * The largest `s` in [0, 1] for which a `width` x `height` box grown by
 * `s · marginX` and `s · marginY` on each side has an area within `maxArea`.
 */
export function marginScale(
  width: number,
  height: number,
  marginX: number,
  marginY: number,
  maxArea: number,
): number {
  const grown = (width + 2 * marginX) * (height + 2 * marginY);
  if (grown <= maxArea) return 1;
  // (w + 2s·mx)(h + 2s·my) = maxArea, a quadratic in s with a = 4·mx·my,
  // b = 2(w·my + h·mx) and c = w·h − maxArea ≤ 0: its non-negative root.
  const a = 4 * marginX * marginY;
  const b = 2 * (width * marginY + height * marginX);
  const c = width * height - maxArea;
  if (c >= 0 || b === 0) return 0;
  const root = a === 0 ? -c / b : (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return Math.max(0, Math.min(1, root));
}

/**
 * The live preview's next bounds: `bounds` (the buffer's box, in cells) grown
 * by a margin so the preview is not rebuilt at every step, clipped to the
 * `imageWidth` x `imageHeight` cell grid, and always containing `bounds`.
 * Pure, so the margin rule can be tested without drawing a preview.
 */
export function growPreviewBounds(
  bounds: MaskRegion,
  imageWidth: number,
  imageHeight: number,
): MaskRegion {
  // Never growing a side past what a canvas can draw: the margin is a
  // convenience, and a preview refused for its margin alone would abandon a
  // stroke whose mask draws fine once committed.
  const sideX = Math.max(
    0,
    Math.min(Math.ceil(bounds.width / 2), Math.floor((MAX_MASK_CANVAS_SIDE - bounds.width) / 2)),
  );
  const sideY = Math.max(
    0,
    Math.min(Math.ceil(bounds.height / 2), Math.floor((MAX_MASK_CANVAS_SIDE - bounds.height) / 2)),
  );
  // Nor letting the margin take the preview past 16 Mi while the buffer's
  // box (the mask rounded out to growth chunks, which the preview always
  // covers) is within it, or cost more than that box once past it
  // (#158, #243 P5): half the extent on every side made a preview up to 4x
  // the buffer — 466 MB of RGBA for a 53 MB mask — and a mask of 4 Mi cells
  // a preview past the 16 Mi an iPad draws. Past the budget the margin still
  // scales with the extent, so growth stays geometric; under it, growth costs
  // a bounded number of copies of at most the budget each.
  // Each side's margin clipped to the room the image leaves first: the
  // budget was charged for margin the edge then clipped away, so near it the
  // margin shrank below a growth chunk and the preview was rebuilt about
  // once per chunk (23 previews on a full-height 20,000 x 2,000 bar; #243
  // round 2, minor 6).
  const room = {
    left: Math.min(sideX, bounds.x),
    right: Math.min(sideX, Math.max(0, imageWidth - bounds.x - bounds.width)),
    top: Math.min(sideY, bounds.y),
    bottom: Math.min(sideY, Math.max(0, imageHeight - bounds.y - bounds.height)),
  };
  const area = bounds.width * bounds.height;
  // `marginScale` grows each axis by twice its margin, so an axis's two
  // sides are passed as their mean.
  const scale = marginScale(
    bounds.width,
    bounds.height,
    (room.left + room.right) / 2,
    (room.top + room.bottom) / 2,
    area <= MAX_MASK_CANVAS_PIXELS ? MAX_MASK_CANVAS_PIXELS : 2 * area,
  );

  // `min`/`max` against `bounds` on both sides, so containment is structural
  // rather than a property the margins happen to preserve. Whatever the
  // image size says, the preview always covers what the buffer holds.
  const left = Math.min(bounds.x, Math.max(0, bounds.x - Math.floor(room.left * scale)));
  const top = Math.min(bounds.y, Math.max(0, bounds.y - Math.floor(room.top * scale)));
  const right = Math.max(
    bounds.x + bounds.width,
    Math.min(imageWidth, bounds.x + bounds.width + Math.floor(room.right * scale)),
  );
  const bottom = Math.max(
    bounds.y + bounds.height,
    Math.min(imageHeight, bounds.y + bounds.height + Math.floor(room.bottom * scale)),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}
