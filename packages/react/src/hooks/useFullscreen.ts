import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  getFullscreenElement,
  isFullscreenSupported,
  onFullscreenChange,
  toggleFullscreen,
} from 'osdlabel';

export interface UseFullscreenResult {
  /** The element currently displayed fullscreen, or `null`. */
  readonly fullscreenElement: Element | null;
  /** Whether any element is currently displayed fullscreen. */
  readonly isFullscreen: boolean;
  /** Whether this browser exposes an element-level Fullscreen API. */
  readonly isSupported: boolean;
  /**
   * Enter fullscreen for `target`, or leave it if anything is already
   * fullscreen. Must be called from within a user gesture. Resolves `false` if
   * the browser refused.
   */
  readonly toggle: (target: Element) => Promise<boolean>;
}

/** Module-level so the subscription identity is stable across renders. */
const subscribe = (onStoreChange: () => void): (() => void) => onFullscreenChange(onStoreChange);

/** Nothing is fullscreen on the server. */
const getServerSnapshot = (): Element | null => null;

/**
 * Track and control the browser's fullscreen state.
 *
 * The browser owns this state, not the annotator: Escape, F11, and the
 * browser's own exit affordance all change it without going through any
 * action. So it is read from `document` via `useSyncExternalStore` rather than
 * mirrored into reducer state where it could silently desync.
 * `getFullscreenElement` returns a stable reference while unchanged, so the
 * store snapshot does not thrash.
 *
 * Independent of `AnnotatorProvider`, so a host can build its own fullscreen
 * button without adopting the rest of the annotator's state.
 */
export function useFullscreen(): UseFullscreenResult {
  const fullscreenElement = useSyncExternalStore(
    subscribe,
    getFullscreenElement,
    getServerSnapshot,
  );

  // Deferred to an effect so hydration matches the server's `false`.
  const [isSupported, setIsSupported] = useState(false);
  useEffect(() => {
    setIsSupported(isFullscreenSupported());
  }, []);

  const toggle = useCallback((target: Element) => toggleFullscreen(target), []);

  return {
    fullscreenElement,
    isFullscreen: fullscreenElement !== null,
    isSupported,
    toggle,
  };
}
