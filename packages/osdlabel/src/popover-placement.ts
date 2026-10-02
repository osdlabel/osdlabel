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

/** `Node.DOCUMENT_FRAGMENT_NODE`, inlined so the module loads without a DOM. */
const NODE_DOCUMENT_FRAGMENT = 11;
/** `Node.ELEMENT_NODE`. */
const NODE_ELEMENT = 1;

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === NODE_ELEMENT
  );
}

/**
 * Parent in the flat tree, the tree layout and clipping actually follow: a
 * slotted element's parent is its slot, and a shadow tree's top elements'
 * parent is the shadow host. `parentElement` alone would skip the shadow
 * tree's wrappers around slotted content and stop dead at a shadow root.
 *
 * A node slotted into a closed shadow root reports no `assignedSlot`, so the
 * walk follows its light-DOM parent, the host, and misses the shadow tree's
 * wrappers around the slot.
 */
function flatTreeParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  const parent = el.parentNode;
  // Not `instanceof ShadowRoot`, which is false for a shadow root from another
  // realm (an iframe's).
  if (parent && parent.nodeType === NODE_DOCUMENT_FRAGMENT && 'host' in parent) {
    const host: unknown = parent.host;
    if (isElement(host)) return host;
  }
  return el.parentElement;
}

const CONTAIN_LAYOUT = /\b(layout|paint|strict|content)\b/;
const CONTAIN_PAINT = /\b(paint|strict|content)\b/;
// Exact `will-change` tokens, not substrings: `scroll-position`,
// `transform-origin` or `perspective-origin` name no containing block.
const WILL_CHANGE_CONTAINING_BLOCK: ReadonlySet<string> = new Set([
  'transform',
  'transform-style',
  'perspective',
  'filter',
  'backdrop-filter',
  'translate',
  'rotate',
  'scale',
  'contain',
  'offset-path',
  'offset-position',
]);

/** The comma-separated tokens of a computed `will-change`. */
function willChangeTokens(style: CSSStyleDeclaration): readonly string[] {
  return style.willChange.split(',').map((token) => token.trim());
}

/** A computed value that is set to something other than its initial `none`. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'none';
}

/**
 * Whether `content-visibility` skips the element's contents, which applies
 * layout and paint containment without showing up in the computed `contain`.
 */
function skipsContents(style: CSSStyleDeclaration): boolean {
  const value = style.contentVisibility;
  return value !== undefined && value !== '' && value !== 'visible';
}

/**
 * Whether the element is the containing block for `position: fixed` (and
 * absolutely positioned) descendants even though it is not positioned
 * itself: a transform (`transform`, `translate`, `rotate` or `scale`),
 * `perspective`, `transform-style: preserve-3d`, a filter, layout or paint
 * containment (including `content-visibility`'s), or a `will-change` promise
 * of one of those. None of them apply to an inline box.
 */
function establishesContainingBlockForFixed(style: CSSStyleDeclaration): boolean {
  if (style.display === 'inline') return false;
  return (
    isSet(style.transform) ||
    isSet(style.translate) ||
    isSet(style.rotate) ||
    isSet(style.scale) ||
    isSet(style.perspective) ||
    style.transformStyle === 'preserve-3d' ||
    isSet(style.filter) ||
    isSet(style.backdropFilter) ||
    CONTAIN_LAYOUT.test(style.contain) ||
    skipsContents(style) ||
    willChangeTokens(style).some((token) => WILL_CHANGE_CONTAINING_BLOCK.has(token))
  );
}

/**
 * Whether the element is the containing block for absolutely positioned
 * descendants: positioned, any of the above, or `will-change: position`,
 * which promises a position and so contains absolute boxes but not fixed ones.
 */
function establishesContainingBlockForAbsolute(style: CSSStyleDeclaration): boolean {
  return (
    style.position !== 'static' ||
    establishesContainingBlockForFixed(style) ||
    willChangeTokens(style).includes('position')
  );
}

/**
 * Whether the element clips its contents horizontally: an `overflow-x` other
 * than `visible`, or paint containment (including `content-visibility`'s).
 * Neither applies to an inline box.
 */
function clipsHorizontally(style: CSSStyleDeclaration): boolean {
  if (style.display === 'inline') return false;
  return style.overflowX !== 'visible' || CONTAIN_PAINT.test(style.contain) || skipsContents(style);
}

/**
 * Whether the element is in the top layer, which escapes every ancestor's
 * clip: the fullscreen element, a modal `<dialog>`, or an open popover.
 */
function isInTopLayer(el: Element): boolean {
  if (el === el.ownerDocument.fullscreenElement) return true;
  try {
    return el.matches(':modal, :popover-open');
  } catch {
    // A browser that does not know one of the pseudo-classes rejects the
    // whole selector; it has no such top-layer elements either.
    return false;
  }
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
 *   establishes a containing block without being positioned (a transform or
 *   individual `translate` / `rotate` / `scale`, `perspective`,
 *   `transform-style: preserve-3d`, a filter, layout or paint containment
 *   including `content-visibility`'s, or a matching `will-change`, where
 *   `will-change: position` counts for absolute boxes only);
 * - a `position: fixed` box escapes everything up to such a
 *   containing-block-establishing ancestor, or up to the viewport;
 * - an element in the top layer (the fullscreen element, a modal `<dialog>`,
 *   an open popover) escapes every ancestor;
 * - a `<body>` whose overflow propagates to the viewport (because the root's
 *   overflow is `visible` on both axes) does not clip, nor does an element
 *   with `display: contents`, which has no box.
 *
 * Clipping comes from `overflow-x` other than `visible` and from paint
 * containment, `content-visibility`'s included. Neither clipping nor the
 * non-positioned containing blocks apply to an inline box. Each clipping
 * element contributes its padding box (`clientLeft` / `clientWidth`); the
 * viewport contributes its `clientWidth`, which excludes a vertical scrollbar.
 *
 * Not modelled: `clip-path` and other shaped clips; transforms other than
 * translation (or `zoom`) on a clipping ancestor, whose `getBoundingClientRect`
 * is transformed but `clientWidth` is not; and `offset-path`, which moves the
 * element (Chromium does not treat it as a containing block, though
 * `will-change: offset-path` is one). Container queries are deliberately
 * absent: `container-type` does not establish a containing block.
 *
 * Missing a real clip widens the bounds, and the popover can then open into
 * it, as before #147; counting a clip that isn't there only flips it the less
 * usual way.
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

    if (escaping === 'absolute' && establishesContainingBlockForAbsolute(style)) {
      escaping = 'none';
    } else if (escaping === 'fixed' && establishesContainingBlockForFixed(style)) {
      escaping = 'none';
    }

    const isPropagatedBody = el === doc.body && bodyOverflowGoesToViewport;
    if (escaping === 'none' && !isPropagatedBody && clipsHorizontally(style)) {
      const rect = el.getBoundingClientRect();
      const paddingLeft = rect.left + el.clientLeft;
      left = Math.max(left, paddingLeft);
      right = Math.min(right, paddingLeft + el.clientWidth);
    }

    if (isInTopLayer(el)) break;
    if (style.position === 'fixed') escaping = 'fixed';
    else if (style.position === 'absolute') escaping = 'absolute';
  }
  return { left, right };
}
