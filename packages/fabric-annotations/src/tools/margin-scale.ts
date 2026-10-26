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
