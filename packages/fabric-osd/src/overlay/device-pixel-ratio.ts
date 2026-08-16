import { config as fabricConfig } from 'fabric';

/**
 * Decide whether Fabric's configured device pixel ratio should be replaced.
 *
 * Pure, so the decision table is testable without touching Fabric's
 * process-wide `config` singleton.
 *
 * Returns the value to apply, or `null` when nothing should change — either
 * because the ratio is unchanged or because the candidate is not a usable
 * ratio. A zero or negative backing-store scale would collapse the canvas, and
 * `NaN` would propagate into every subsequent dimension calculation, so those
 * are rejected rather than written.
 */
export function resolveDevicePixelRatioChange(current: number, next: number): number | null {
  if (!Number.isFinite(next) || next <= 0) return null;
  return next === current ? null : next;
}

/** The window's current device pixel ratio, or `1` outside a browser. */
export function readWindowDevicePixelRatio(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio;
}

/**
 * Bring Fabric's `config.devicePixelRatio` back in line with the window's.
 *
 * Fabric captures `window.devicePixelRatio` exactly once, when its `config`
 * module is evaluated, and `Canvas.setDimensions()` re-applies whatever was
 * captured (via `getRetinaScaling()`). Moving the window to a display with a
 * different scale factor therefore leaves the annotation overlay rendering at
 * the old backing resolution — visibly soft shapes over crisp OSD tiles, since
 * OpenSeadragon re-reads its own `pixelDensityRatio` on window `resize` and
 * self-heals. Fabric has no equivalent, so the overlay does it on Fabric's
 * behalf.
 *
 * Must run *before* any `setDimensions` call that should observe the new
 * ratio. Returns whether the value actually changed.
 */
export function syncFabricDevicePixelRatio(next = readWindowDevicePixelRatio()): boolean {
  const resolved = resolveDevicePixelRatioChange(fabricConfig.devicePixelRatio, next);
  if (resolved === null) return false;
  fabricConfig.devicePixelRatio = resolved;
  return true;
}

/**
 * Invoke `onChange` whenever the device pixel ratio changes.
 *
 * A `resize` listener is not enough: dragging a window between a Retina and a
 * non-Retina display changes the ratio without changing the window's CSS size,
 * so no `resize` fires and neither OSD nor Fabric notices. Matching on
 * `(resolution: Ndppx)` and re-arming the query after each change is the
 * standard way to observe it, since the query has to name the ratio it is
 * watching for.
 *
 * Returns an unsubscribe function. No-ops where `matchMedia` is unavailable
 * (SSR, and jsdom unless the test stubs it).
 */
export function observeDevicePixelRatio(onChange: (ratio: number) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  let query: MediaQueryList | null = null;
  let disposed = false;

  const handle = (): void => {
    if (disposed) return;
    arm();
    onChange(readWindowDevicePixelRatio());
  };

  function arm(): void {
    if (disposed) return;
    query = window.matchMedia(`(resolution: ${readWindowDevicePixelRatio()}dppx)`);
    // `once` matters: the query only ever transitions away from its own ratio,
    // so each one is good for a single change and is replaced by `arm()`.
    query.addEventListener('change', handle, { once: true });
  }

  arm();

  return () => {
    disposed = true;
    query?.removeEventListener('change', handle);
    query = null;
  };
}
