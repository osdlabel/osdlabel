import { createSignal, onMount, onCleanup, type Accessor } from 'solid-js';
import {
  getFullscreenElement,
  isFullscreenSupported,
  onFullscreenChange,
  toggleFullscreen,
} from 'osdlabel';

export interface UseFullscreenResult {
  /** The element currently displayed fullscreen, or `null`. */
  readonly fullscreenElement: Accessor<Element | null>;
  /** Whether any element is currently displayed fullscreen. */
  readonly isFullscreen: Accessor<boolean>;
  /** Whether this browser exposes an element-level Fullscreen API. */
  readonly isSupported: Accessor<boolean>;
  /**
   * Enter fullscreen for `target`, or leave it if anything is already
   * fullscreen. Must be called from within a user gesture. Resolves `false` if
   * the browser refused.
   */
  readonly toggle: (target: Element) => Promise<boolean>;
}

/**
 * Track and control the browser's fullscreen state.
 *
 * The browser owns this state, not the annotator: Escape, F11, and the
 * browser's own exit affordance all change it without going through any
 * action. So it is read from `document` and kept in sync through
 * `fullscreenchange`, rather than mirrored into `UIState` where it could
 * silently desync.
 *
 * Independent of `AnnotatorProvider`, so a host can build its own fullscreen
 * button without adopting the rest of the annotator's state.
 */
export function useFullscreen(): UseFullscreenResult {
  const [element, setElement] = createSignal<Element | null>(null);
  const [supported, setSupported] = createSignal(false);

  // Read in onMount rather than at setup, so server-rendered output matches
  // the client's first paint.
  onMount(() => {
    setSupported(isFullscreenSupported());
    setElement(getFullscreenElement());
    const unsubscribe = onFullscreenChange(() => setElement(getFullscreenElement()));
    onCleanup(unsubscribe);
  });

  return {
    fullscreenElement: element,
    isFullscreen: () => element() !== null,
    isSupported: supported,
    toggle: toggleFullscreen,
  };
}
