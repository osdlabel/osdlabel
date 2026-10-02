/**
 * Which edge of its anchor a dropdown popover lines up with:
 *
 * - `'start'`: its left edge on the anchor's left edge, opening rightward;
 * - `'end'`: its right edge on the anchor's right edge, opening leftward.
 */
export type PopoverAlignment = 'start' | 'end';

/** A horizontal extent in viewport (client) coordinates. */
export interface HorizontalSpan {
  readonly left: number;
  readonly right: number;
}

/** How far `[left, right]` sticks out of `bounds`, summed over both sides. */
function overflow(left: number, right: number, bounds: HorizontalSpan): number {
  return Math.max(0, bounds.left - left) + Math.max(0, right - bounds.right);
}

/**
 * Picks the alignment that keeps a popover of `popoverWidth` inside `bounds`.
 *
 * Prefers `'start'`, the conventional direction, whenever it fits. Otherwise
 * `'end'` if that fits, and when neither fits (a popover wider than the bounds)
 * whichever overflows less, so as much of it as possible stays reachable.
 *
 * Pure, so it is unit-tested without a DOM and shared by the SolidJS and React
 * `GridControls`.
 */
export function choosePopoverAlignment(
  anchor: HorizontalSpan,
  popoverWidth: number,
  bounds: HorizontalSpan,
): PopoverAlignment {
  const startOverflow = overflow(anchor.left, anchor.left + popoverWidth, bounds);
  if (startOverflow === 0) return 'start';
  const endOverflow = overflow(anchor.right - popoverWidth, anchor.right, bounds);
  if (endOverflow === 0) return 'end';
  return endOverflow < startOverflow ? 'end' : 'start';
}

/**
 * The horizontal region a popover positioned inside `element` can be seen in:
 * the viewport, narrowed by every ancestor whose `overflow-x` clips (anything
 * but `visible`).
 *
 * An absolutely positioned popover is clipped by each such ancestor of its
 * containing block, which is how the grid popover came to be cut off by a host
 * toolbar slot near a right edge (#147). Uses each clipping ancestor's padding
 * box (`clientLeft` / `clientWidth`), which is the box overflow clips to, and
 * the viewport's `clientWidth`, which excludes a vertical scrollbar.
 */
export function getHorizontalClipBounds(element: Element): HorizontalSpan {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  let left = 0;
  let right = doc.documentElement.clientWidth;
  if (!view) return { left, right };

  for (let el = element.parentElement; el; el = el.parentElement) {
    // The root element's overflow applies to the viewport, which is already
    // the starting bounds.
    if (el === doc.documentElement) break;
    if (view.getComputedStyle(el).overflowX === 'visible') continue;
    const rect = el.getBoundingClientRect();
    const paddingLeft = rect.left + el.clientLeft;
    left = Math.max(left, paddingLeft);
    right = Math.min(right, paddingLeft + el.clientWidth);
  }
  return { left, right };
}
