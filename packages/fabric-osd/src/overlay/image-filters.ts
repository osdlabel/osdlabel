import type { CellTransform } from '@osdlabel/viewer-api';

/** The tonal adjustments of a cell transform, rendered as CSS filters. */
export type ImageFilters = Pick<CellTransform, 'exposure' | 'contrast' | 'inverted'>;

/**
 * Compose the CSS `filter` value for a cell's tonal adjustments. Returns an
 * empty string when nothing is adjusted so the caller can clear the property
 * instead of painting an identity filter (which would still force the browser
 * onto the filtered compositing path).
 *
 * Order matters and is fixed: `brightness()` scales, then `contrast()` expands
 * around mid-grey, then the optional `invert()`. Swapping brightness and
 * contrast produces a different image, so the order is part of the contract.
 *
 * `exposure` and `contrast` are both in `[-1, 1]` with `0` meaning unchanged;
 * each maps onto its CSS filter's `0–2` range as `1 + value`.
 */
export function composeImageFilterCss(filters: ImageFilters): string {
  const parts: string[] = [];
  if (filters.exposure !== 0) {
    parts.push(`brightness(${1 + filters.exposure})`);
  }
  if (filters.contrast !== 0) {
    parts.push(`contrast(${1 + filters.contrast})`);
  }
  if (filters.inverted) {
    parts.push('invert(1)');
  }
  return parts.join(' ');
}
