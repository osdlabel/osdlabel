import type { Point } from '@osdlabel/annotation';
import { mirrorScreenX } from './mirror-screen-x.js';

/**
 * Multiplicative zoom applied per wheel notch. Matches OpenSeadragon's
 * `zoomPerScroll` default so the manual Ctrl/Cmd+wheel path in annotation mode
 * feels identical to OSD's own scroll-zoom in navigation mode.
 */
export const SCROLL_ZOOM_PER_NOTCH = 1.2;

/** Inputs for {@link computeScrollZoom}. */
export interface ScrollZoomInput {
  /**
   * `WheelEvent.deltaY`. Only its sign is used, so `deltaMode` (pixel / line /
   * page) does not matter.
   */
  readonly deltaY: number;
  /**
   * Pointer position in CSS pixels, relative to the viewer element — NOT
   * client/window coordinates. See {@link computeScrollZoom}.
   */
  readonly position: Point;
  /** `viewport.getContainerSize().x`, in CSS pixels. */
  readonly containerWidth: number;
  /** `viewport.getFlip()`. */
  readonly flipped: boolean;
}

/** The zoom to apply for one wheel notch. */
export interface ScrollZoomCommand {
  /** Factor to pass to `viewport.zoomBy`. */
  readonly factor: number;
  /** Element-relative pixel to pass to `viewport.pointFromPixel(_, true)`. */
  readonly anchorPixel: Point;
}

/**
 * Compute the zoom factor and anchor point for a Ctrl/Cmd+wheel gesture.
 *
 * Two things make this non-obvious, and both were previously wrong:
 *
 * 1. **The anchor must be element-relative.** `viewport.pointFromPixel` only
 *    subtracts OSD's own margins — it expects a pixel in the viewer element's
 *    coordinate space, not the window's. Passing `clientX` / `clientY` offsets
 *    the anchor by wherever the viewer sits on the page, so the view drifts
 *    away from the cursor as you zoom. Entering fullscreen changes that offset,
 *    which is how the bug was found.
 * 2. **The anchor must be flip-mirrored.** OSD's own `onCanvasScroll` mirrors
 *    `position.x` around the container width before calling `pointFromPixel`
 *    whenever the viewport is flipped; anything else zooms toward the mirror
 *    image of the cursor.
 *
 * Returns `null` when there is nothing to do — specifically when `deltaY` is
 * zero, as a purely horizontal wheel (trackpad shear, tilt wheel) produces. A
 * naive sign test treats that as "scroll down" and zooms out spuriously.
 */
export function computeScrollZoom(input: ScrollZoomInput): ScrollZoomCommand | null {
  if (input.deltaY === 0) return null;

  // deltaY is negative when the wheel is pushed away from the user (zoom in).
  const factor = input.deltaY < 0 ? SCROLL_ZOOM_PER_NOTCH : 1 / SCROLL_ZOOM_PER_NOTCH;

  return {
    factor,
    anchorPixel: {
      x: mirrorScreenX(input.position.x, input.containerWidth, input.flipped),
      y: input.position.y,
    },
  };
}
