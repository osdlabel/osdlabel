/**
 * Mirror an element-relative screen x-coordinate for a horizontally flipped
 * viewport.
 *
 * OpenSeadragon applies flip only in its drawer's rendering pipeline
 * (`context.scale(-1, 1)`); none of its coordinate-conversion methods account
 * for it. Every place that maps between screen-space and image-space therefore
 * has to compose the same mirror around `x = containerWidth / 2`, which
 * reduces to `x' = containerWidth - x`.
 *
 * Encoding it once means the overlay transform, the point conversions, and the
 * scroll-zoom anchor cannot drift apart.
 */
export function mirrorScreenX(x: number, containerWidth: number, flipped: boolean): number {
  return flipped ? containerWidth - x : x;
}
