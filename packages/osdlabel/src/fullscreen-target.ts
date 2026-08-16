/**
 * Marks the element a fullscreen toggle should target when the host composes
 * its own layout instead of rendering `<Annotator>`.
 *
 * Put it on the element that wraps the whole annotator UI:
 *
 * ```html
 * <div data-osdlabel-fullscreen-root>
 *   <Toolbar /> <ViewControls /> <GridView /> …
 * </div>
 * ```
 */
export const FULLSCREEN_ROOT_ATTRIBUTE = 'data-osdlabel-fullscreen-root';

/** Inputs to {@link resolveFullscreenTarget}, in precedence order. */
export interface ResolveFullscreenTargetOptions {
  /** Explicit override, from the provider's `fullscreenTarget` prop. */
  readonly explicit?: HTMLElement | (() => HTMLElement | null) | null | undefined;
  /** The `<Annotator>` root, when one is mounted. */
  readonly registered?: HTMLElement | null | undefined;
  /** The node the gesture came from — normally the toggle button itself. */
  readonly from?: Element | null | undefined;
}

/**
 * Decide which element to display fullscreen.
 *
 * Four tiers, most specific first:
 *
 * 1. `explicit` — the host named an element (or a getter for one).
 * 2. `registered` — `<Annotator>` mounted and registered its root.
 * 3. the nearest `[data-osdlabel-fullscreen-root]` ancestor of `from`, which is
 *    how a hand-composed layout opts in with one attribute.
 * 4. `document.documentElement`, so the control is never inert. Fullscreening
 *    the page is not always what the host wanted, but it is closer than doing
 *    nothing, and tiers 1–3 cover every case where the intent is expressible.
 *
 * Returns `null` only when there is no document at all (SSR).
 */
export function resolveFullscreenTarget(
  options: ResolveFullscreenTargetOptions,
): HTMLElement | null {
  if (typeof document === 'undefined') return null;

  const explicit = typeof options.explicit === 'function' ? options.explicit() : options.explicit;
  if (explicit) return explicit;

  if (options.registered) return options.registered;

  const ancestor = options.from?.closest(`[${FULLSCREEN_ROOT_ATTRIBUTE}]`);
  if (ancestor instanceof HTMLElement) return ancestor;

  return document.documentElement;
}
