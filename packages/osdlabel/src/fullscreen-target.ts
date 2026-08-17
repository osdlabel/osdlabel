/** Inputs to {@link resolveFullscreenTarget}, in precedence order. */
export interface ResolveFullscreenTargetOptions {
  /** Explicit override, from the provider's `fullscreenTarget` prop. */
  readonly explicit?: HTMLElement | (() => HTMLElement | null) | null | undefined;
  /**
   * The element registered on the annotator context's `fullscreenTargetRef` —
   * the `<Annotator>` root, or a custom layout's own root if it registered one.
   */
  readonly registered?: HTMLElement | null | undefined;
}

/**
 * Decide which element to display fullscreen.
 *
 * Three tiers, most specific first:
 *
 * 1. `explicit` — the host named an element (or a getter for one) through the
 *    `fullscreenTarget` prop.
 * 2. `registered` — whatever claimed `fullscreenTargetRef`. `<Annotator>` does
 *    this with its own root; a host composing its own layout does the same on
 *    the element that wraps the annotator UI.
 * 3. `document.documentElement`, so the control is never inert. Fullscreening
 *    the page is not always what the host wanted, but it is closer than doing
 *    nothing, and tiers 1–2 cover every case where the intent is expressible.
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

  return document.documentElement;
}
