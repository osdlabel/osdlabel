/**
 * Which edge of its anchor a dropdown popover lines up with:
 *
 * - `'start'`: its left edge on the anchor's left edge, opening rightward;
 * - `'end'`: its right edge on the anchor's right edge, opening leftward.
 *
 * Physical, not logical: `'start'` is the left edge in a right-to-left
 * document too.
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
 * The horizontal region an absolutely positioned popover whose containing
 * block is `element` can be seen in: the viewport, narrowed by every element
 * that actually clips it.
 *
 * That is the containing-block chain, not every ancestor: an element whose
 * `overflow-x` is not `visible` clips the boxes whose containing block is it or
 * lies inside it. So the walk follows the browser's rules:
 *
 * - it starts at `element` itself, the popover's containing block;
 * - an absolutely positioned box escapes the non-positioned (`static`)
 *   ancestors between it and its own containing block;
 * - a `position: fixed` box escapes everything above it, and so does the
 *   fullscreen element, which is promoted to the top layer;
 * - a `<body>` whose overflow propagates to the viewport (because the root's
 *   is `visible`) does not clip at all.
 *
 * Each clipping element contributes its padding box (`clientLeft` /
 * `clientWidth`), which is the box overflow clips to; the viewport contributes
 * its `clientWidth`, which excludes a vertical scrollbar. Not modelled:
 * `contain: paint`, `clip-path`, a fixed box whose containing block is a
 * transformed ancestor, and scaled transforms on a clipping ancestor. Each of
 * those can only make the bounds wider or narrower than real, which at worst
 * opens the popover in the less usual direction.
 *
 * This is how the grid popover came to be cut off by a host toolbar slot near
 * a right edge (#147). Exercised end to end by `grid-popover.spec.ts`; there is
 * no DOM in this package's unit-test environment.
 */
export function getHorizontalClipBounds(element: Element): HorizontalSpan {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  let left = 0;
  let right = doc.documentElement.clientWidth;
  if (!view) return { left, right };

  const rootOverflowVisible = view.getComputedStyle(doc.documentElement).overflowX === 'visible';
  // True while walking past ancestors that an absolutely positioned box in
  // the chain escapes, until its containing block (a positioned ancestor).
  let escaping = false;

  for (let el: Element | null = element; el; el = el.parentElement) {
    // The root element's overflow applies to the viewport, which is already
    // the starting bounds.
    if (el === doc.documentElement) break;
    const style = view.getComputedStyle(el);
    if (escaping && style.position !== 'static') escaping = false;

    const propagatedToViewport = el === doc.body && rootOverflowVisible;
    if (!escaping && !propagatedToViewport && style.overflowX !== 'visible') {
      const rect = el.getBoundingClientRect();
      const paddingLeft = rect.left + el.clientLeft;
      left = Math.max(left, paddingLeft);
      right = Math.min(right, paddingLeft + el.clientWidth);
    }

    if (style.position === 'fixed' || el === doc.fullscreenElement) break;
    if (style.position === 'absolute') escaping = true;
  }
  return { left, right };
}
