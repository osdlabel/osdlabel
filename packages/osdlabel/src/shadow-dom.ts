/**
 * Helpers that keep DOM checks correct when the annotator renders inside a
 * shadow root (as `<osdlabel-annotator>` does).
 *
 * A listener outside a shadow root sees `event.target` retargeted to the
 * shadow host, and `document.activeElement` is the host too, so checks
 * written against them look at the wrong element.
 */

/**
 * The element an event originated on, looking through shadow boundaries.
 *
 * `event.target` unless it is a shadow host, i.e. the event was retargeted out
 * of a shadow root: then `composedPath()[0]`, the original target (for an open
 * root; a closed root's path stops at its host, which is then what this
 * returns). Outside dispatch the path is empty, and this is `event.target`.
 */
export function getEventOrigin(event: Event): EventTarget | null {
  const target = event.target;
  const isShadowHost =
    typeof target === 'object' &&
    target !== null &&
    'shadowRoot' in target &&
    target.shadowRoot !== null &&
    target.shadowRoot !== undefined;
  if (!isShadowHost) return target;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path[0] ?? target;
}

/**
 * Whether `element` has focus within its own tree: the document's
 * `activeElement` for a light-DOM element, its shadow root's for one inside a
 * shadow root. `document.activeElement === element` is never true for the
 * latter.
 */
export function isFocusedInItsRoot(element: Element): boolean {
  const root = element.getRootNode();
  return 'activeElement' in root && root.activeElement === element;
}
