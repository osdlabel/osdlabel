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
 * Parent in the flat tree, the tree layout and clipping actually follow: a
 * slotted element's parent is its slot, and a shadow tree's top elements'
 * parent is the shadow host. `parentElement` alone would skip the shadow
 * tree's wrappers around slotted content and stop dead at a shadow root.
 */
function flatTreeParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  const parent = el.parentNode;
  if (parent instanceof ShadowRoot) return parent.host;
  return el.parentElement;
}

const CONTAIN_LAYOUT = /\b(layout|paint|strict|content)\b/;
const CONTAIN_PAINT = /\b(paint|strict|content)\b/;
const WILL_CHANGE_CONTAINING_BLOCK = /\b(transform|perspective|filter|backdrop-filter)\b/;

/**
 * Whether the element is the containing block for `position: fixed` (and
 * absolutely positioned) descendants even though it is not positioned
 * itself: a transform, perspective, filter, layout or paint containment, a
 * container query container, or a `will-change` promise of one of those.
 */
function establishesContainingBlockForFixed(style: CSSStyleDeclaration): boolean {
  return (
    style.transform !== 'none' ||
    style.perspective !== 'none' ||
    style.filter !== 'none' ||
    (style.backdropFilter !== undefined &&
      style.backdropFilter !== '' &&
      style.backdropFilter !== 'none') ||
    CONTAIN_LAYOUT.test(style.contain) ||
    WILL_CHANGE_CONTAINING_BLOCK.test(style.willChange) ||
    (style.containerType !== undefined &&
      style.containerType !== '' &&
      style.containerType !== 'normal')
  );
}

/**
 * Whether the element clips its contents horizontally: an `overflow-x` other
 * than `visible` (which does not apply to inline boxes), or paint containment.
 */
function clipsHorizontally(style: CSSStyleDeclaration): boolean {
  if (CONTAIN_PAINT.test(style.contain)) return true;
  return style.overflowX !== 'visible' && style.display !== 'inline';
}

/**
 * The horizontal region an absolutely positioned popover whose containing
 * block is `element` can be seen in: the viewport, narrowed by every element
 * that actually clips it.
 *
 * Overflow clips only the boxes whose containing block is the clipping element
 * or lies inside it, so this walks the containing-block chain rather than
 * every ancestor, in the flat tree (through shadow roots and slots):
 *
 * - it starts at `element` itself, the popover's containing block;
 * - an absolutely positioned box escapes the ancestors between it and its own
 *   containing block, which is the nearest positioned ancestor or one that
 *   establishes a containing block without being positioned (a transform,
 *   filter, perspective, layout or paint containment, a container query
 *   container, or a matching `will-change`);
 * - a `position: fixed` box escapes everything up to such a
 *   containing-block-establishing ancestor, or up to the viewport;
 * - the fullscreen element is in the top layer and escapes every ancestor;
 * - a `<body>` whose overflow propagates to the viewport (because the root's
 *   overflow is `visible` on both axes) does not clip, nor does an element
 *   with `display: contents`, which has no box.
 *
 * Clipping comes from `overflow-x` other than `visible` and from paint
 * containment. Each clipping element contributes its padding box
 * (`clientLeft` / `clientWidth`); the viewport contributes its `clientWidth`,
 * which excludes a vertical scrollbar.
 *
 * Not modelled: `clip-path` and other shaped clips, and scaled transforms on a
 * clipping ancestor (whose `getBoundingClientRect` is scaled but `clientWidth`
 * is not). Missing a real clip widens the bounds, and the popover can then
 * open into it, as before #147; counting a clip that isn't there only flips it
 * the less usual way.
 *
 * Exercised end to end by `grid-popover.spec.ts`; there is no DOM in this
 * package's unit-test environment.
 */
export function getHorizontalClipBounds(element: Element): HorizontalSpan {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  let left = 0;
  let right = doc.documentElement.clientWidth;
  if (!view) return { left, right };

  const rootStyle = view.getComputedStyle(doc.documentElement);
  const bodyOverflowGoesToViewport =
    rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible';

  // Which positioned box in the chain is skipping ancestors that do not
  // contain it, until its containing block: none, an absolutely positioned
  // box, or a fixed one.
  let escaping: 'none' | 'absolute' | 'fixed' = 'none';

  for (let el: Element | null = element; el; el = flatTreeParent(el)) {
    // The root element's overflow applies to the viewport, which is already
    // the starting bounds.
    if (el === doc.documentElement) break;
    const style = view.getComputedStyle(el);
    // No box: it cannot clip or contain anything.
    if (style.display === 'contents') continue;

    const containsFixed = establishesContainingBlockForFixed(style);
    if (escaping === 'absolute' && (style.position !== 'static' || containsFixed)) {
      escaping = 'none';
    } else if (escaping === 'fixed' && containsFixed) {
      escaping = 'none';
    }

    const isPropagatedBody = el === doc.body && bodyOverflowGoesToViewport;
    if (escaping === 'none' && !isPropagatedBody && clipsHorizontally(style)) {
      const rect = el.getBoundingClientRect();
      const paddingLeft = rect.left + el.clientLeft;
      left = Math.max(left, paddingLeft);
      right = Math.min(right, paddingLeft + el.clientWidth);
    }

    if (el === doc.fullscreenElement) break;
    if (style.position === 'fixed') escaping = 'fixed';
    else if (style.position === 'absolute') escaping = 'absolute';
  }
  return { left, right };
}
