/**
 * Cross-browser access to the Fullscreen API.
 *
 * Covers the standard names plus Safari's `webkit` prefix. Firefox has been
 * unprefixed since 64 and the `moz` / `ms` forms are dead, but Safari only
 * dropped the prefix in 16.4 and older iPadOS builds are still in use.
 */

/** Safari's prefixed subset of the Fullscreen API on `Document`. */
interface WebkitFullscreenDocument {
  readonly webkitFullscreenElement?: Element | null | undefined;
  readonly webkitFullscreenEnabled?: boolean | undefined;
  readonly webkitExitFullscreen?: (() => Promise<void> | void) | undefined;
}

/** Safari's prefixed subset of the Fullscreen API on `Element`. */
interface WebkitFullscreenElement {
  readonly webkitRequestFullscreen?:
    | ((options?: FullscreenOptions) => Promise<void> | void)
    | undefined;
}

type FullscreenDocument = Document & WebkitFullscreenDocument;
type FullscreenCapableElement = Element & WebkitFullscreenElement;

const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;

/**
 * The element currently displayed fullscreen, or `null` if none is.
 *
 * The `?? null` normalization is load-bearing, not defensive style. In an
 * environment without the Fullscreen API — jsdom, notably — the property is
 * absent, so `document.fullscreenElement` is `undefined` and a bare
 * `!== null` test reports "fullscreen" everywhere. Every read of fullscreen
 * state in the library goes through this function for that reason.
 */
export function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Whether any element on the page is currently displayed fullscreen. */
export function isDocumentFullscreen(): boolean {
  return getFullscreenElement() !== null;
}

/**
 * Whether this browser exposes an element-level Fullscreen API.
 *
 * `false` on iPhone Safari, which has no `Element.requestFullscreen` at all
 * (only `HTMLVideoElement.webkitEnterFullscreen`), and wherever a permissions
 * policy has disabled fullscreen for the document — an annotator inside an
 * `<iframe>` without `allow="fullscreen"`, for instance. Callers should hide
 * their fullscreen affordance rather than offer one that cannot work.
 */
export function isFullscreenSupported(): boolean {
  if (typeof document === 'undefined' || typeof Element === 'undefined') return false;
  const doc = document as FullscreenDocument;
  if (doc.fullscreenEnabled === false && doc.webkitFullscreenEnabled !== true) return false;
  const proto = Element.prototype as FullscreenCapableElement;
  return (
    typeof proto.requestFullscreen === 'function' ||
    typeof proto.webkitRequestFullscreen === 'function'
  );
}

/**
 * Request fullscreen for `element`. Must be called from within a user gesture.
 *
 * Resolves `true` when the request was made and accepted, `false` when the
 * browser refused — no user gesture, a `fullscreen=()` permissions policy, or
 * no API at all. Never rejects: a refusal is a legitimate browser decision,
 * and an unhandled rejection inside a click handler is a console error the
 * caller cannot do anything about. The UI stays correct either way, because
 * `fullscreenchange` simply never fires.
 */
export async function requestFullscreen(element: Element): Promise<boolean> {
  const target = element as FullscreenCapableElement;
  const request = target.requestFullscreen ?? target.webkitRequestFullscreen;
  if (typeof request !== 'function') return false;
  try {
    // Safari's prefixed form returns undefined rather than a Promise.
    await Promise.resolve(request.call(target));
    return true;
  } catch {
    return false;
  }
}

/** Exit fullscreen. Resolves `true` if an exit was actually requested. */
export async function exitFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const doc = document as FullscreenDocument;
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (typeof exit !== 'function') return false;
  try {
    await Promise.resolve(exit.call(doc));
    return true;
  } catch {
    return false;
  }
}

/**
 * Exit if anything is fullscreen, otherwise enter fullscreen for `element`.
 * Must be called from within a user gesture.
 */
export function toggleFullscreen(element: Element): Promise<boolean> {
  return isDocumentFullscreen() ? exitFullscreen() : requestFullscreen(element);
}

/**
 * Subscribe to fullscreen changes. Returns an unsubscribe function.
 *
 * Both the standard and prefixed event names are registered unconditionally.
 * Safari 16.4+ fires both, so the listener can run twice for one transition —
 * harmless, since every consumer derives its state from
 * {@link getFullscreenElement} rather than from the event itself.
 */
export function onFullscreenChange(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  for (const name of CHANGE_EVENTS) {
    document.addEventListener(name, listener);
  }
  return () => {
    for (const name of CHANGE_EVENTS) {
      document.removeEventListener(name, listener);
    }
  };
}

/**
 * Whether the annotator must ignore a keydown because the browser has reserved
 * that key while an element is displayed fullscreen.
 *
 * Only `Escape` is reserved: the user agent exits fullscreen on it, and that
 * cannot be prevented. Handling it as well would make one keypress do two
 * unrelated things — leave fullscreen *and* deselect, clear the active tool,
 * or cancel an in-progress polyline, with the second effect hidden behind the
 * fullscreen transition.
 *
 * The comparison is against the literal `'Escape'` rather than
 * `shortcuts.cancel` on purpose. The reservation is a fact about the browser,
 * not a configurable binding: a consumer who rebinds cancel to `q` must keep
 * `q` working while fullscreen, and the polyline and vertex-editor handlers
 * key off the browser key too.
 *
 * The check is "is *anything* fullscreen", not "is our element fullscreen".
 * The browser consumes Escape for whichever element is fullscreen, including
 * one the host owns — a `<video>`, a lightbox — so scoping it to the
 * annotator's own target would reintroduce exactly the double effect this
 * prevents.
 *
 * Known limitation: browser-native fullscreen (F11, kiosk mode) does not set
 * `document.fullscreenElement`, so this returns `false` there. That is
 * correct — those modes are not exited by Escape either, so there is no double
 * effect to suppress. Heuristics such as comparing `innerHeight` to
 * `screen.height` are unreliable under browser zoom and multi-monitor setups
 * and are deliberately not used.
 */
export function shouldSuppressEscapeKey(key: string): boolean {
  return key === 'Escape' && isDocumentFullscreen();
}
