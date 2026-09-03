import type { MaskBuffer } from './mask-buffer.js';

/**
 * Pixel (px, py) covers the area [px, px+1) x [py, py+1), so its centre is at
 * (px + 0.5, py + 0.5). A pixel belongs to the brush when its centre lies
 * within `radius` of the brush centre.
 */
const PIXEL_CENTRE = 0.5;

/**
 * Below this a disc can miss every pixel centre: a brush centred on a pixel
 * corner needs to reach `sqrt(0.5)` before it covers anything. Radii under it
 * fall back to marking the pixel under the centre, so coverage stays monotonic
 * in radius and a fine brush is never a no-op.
 */
const MIN_COVERING_RADIUS = Math.SQRT1_2;

/**
 * Grows the buffer to cover a disc (or swept disc) before any pixel is written.
 *
 * Two reasons, both about the reallocate-and-blit that a bounded buffer does
 * when a write lands outside its region: doing it once per stamp instead of
 * once per boundary crossed keeps a wide brush affordable, and it moves the
 * only failure painting has — the capacity cap — ahead of the first write, so
 * a stamp that cannot fit leaves the mask untouched instead of half-painted.
 *
 * Painting only; erasing never grows the buffer.
 */
function reserveDisc(
  buffer: MaskBuffer,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  radius: number,
  value: 0 | 1,
): void {
  if (value === 0 || !buffer.reserve) return;
  buffer.reserve({
    x: minX - radius - 1,
    y: minY - radius - 1,
    width: maxX - minX + 2 * radius + 3,
    height: maxY - minY + 2 * radius + 3,
  });
}

/**
 * Paints (or erases) a filled disc of `radius` image pixels centred on
 * (`cx`, `cy`). Radii below {@link MIN_COVERING_RADIUS} still mark the single
 * pixel under the centre, so a fine brush never becomes a no-op.
 *
 * Painting is all-or-nothing: if the mask cannot grow to hold the disc, a
 * {@link MaskCapacityExceededError} is raised before the first pixel is set.
 */
export function stampCircle(
  buffer: MaskBuffer,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 1,
): void {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius)) return;

  if (radius < MIN_COVERING_RADIUS) {
    buffer.set(Math.floor(cx), Math.floor(cy), value);
    return;
  }

  reserveDisc(buffer, cx, cy, cx, cy, radius, value);

  // Clipped to the image, not merely bounded by the radius. `set` already
  // ignores out-of-image writes, but the loops still ran: a radius of 1e6 on a
  // small image iterated trillions of times doing nothing. The brush UI clamps
  // to MAX_BRUSH_RADIUS, so this protects a caller driving the rasterizer
  // directly.
  const firstRow = Math.max(0, Math.ceil(cy - radius - PIXEL_CENTRE));
  const lastRow = Math.min(buffer.imageHeight - 1, Math.floor(cy + radius - PIXEL_CENTRE));
  const radiusSquared = radius * radius;

  for (let py = firstRow; py <= lastRow; py++) {
    const dy = py + PIXEL_CENTRE - cy;
    const halfSpanSquared = radiusSquared - dy * dy;
    if (halfSpanSquared < 0) continue;
    const halfSpan = Math.sqrt(halfSpanSquared);
    const firstCol = Math.max(0, Math.ceil(cx - halfSpan - PIXEL_CENTRE));
    const lastCol = Math.min(buffer.imageWidth - 1, Math.floor(cx + halfSpan - PIXEL_CENTRE));
    for (let px = firstCol; px <= lastCol; px++) {
      buffer.set(px, py, value);
    }
  }
}

/**
 * Paints (or erases) the swept path of the brush between two pointer samples.
 *
 * Pointer events arrive far apart during a fast drag, so stamping only at the
 * sampled positions would leave gaps. Discs are stamped along the segment at a
 * spacing of half the radius, which keeps the swept shape smooth while bounding
 * the work per segment.
 *
 * Like {@link stampCircle}, painting is all-or-nothing: the buffer is grown to
 * hold the whole swept region before the first pixel is written, so a segment
 * that exceeds the mask's capacity leaves it unchanged.
 */
export function strokeSegment(
  buffer: MaskBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: 0 | 1,
): void {
  if (
    !Number.isFinite(x0) ||
    !Number.isFinite(y0) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1)
  ) {
    return;
  }

  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length === 0) {
    stampCircle(buffer, x0, y0, radius, value);
    return;
  }

  // Reserve the whole swept box up front. It is the same region the individual
  // stamps would grow into anyway, reached in one reallocation — and it makes
  // the entire segment atomic rather than just each disc within it.
  if (Number.isFinite(radius)) {
    reserveDisc(
      buffer,
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1),
      radius,
      value,
    );
  }

  const step = Math.max(PIXEL_CENTRE, radius / 2);
  const steps = Math.ceil(length / step);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampCircle(buffer, x0 + dx * t, y0 + dy * t, radius, value);
  }
}
