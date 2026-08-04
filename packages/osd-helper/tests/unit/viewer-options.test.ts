import { describe, it, expect } from 'vitest';
import { DEFAULT_VIEWER_OPTIONS } from '../../src/viewer-options.js';

/**
 * Mirrors `OpenSeadragon.Viewport#getMinZoom` (v5.0.1):
 *
 * ```js
 * var homeZoom = this.getHomeZoom(),
 *     zoom = this.minZoomLevel ? this.minZoomLevel : this.minZoomImageRatio * homeZoom;
 * ```
 */
const osdMinZoom = (
  options: { readonly minZoomLevel?: number; readonly minZoomImageRatio?: number },
  homeZoom: number,
): number =>
  options.minZoomLevel ? options.minZoomLevel : (options.minZoomImageRatio ?? 1) * homeZoom;

/**
 * `getHomeZoom` for a non-`homeFillsViewer` viewer with a unit-width content
 * bounds: fit by width when the image is wider than the cell, else by height.
 */
const osdHomeZoom = (imageAspect: number, containerAspect: number): number => {
  const aspectFactor = imageAspect / containerAspect;
  return aspectFactor >= 1 ? 1 : aspectFactor;
};

describe('DEFAULT_VIEWER_OPTIONS', () => {
  it('bounds zoom-out relative to home zoom, not by an absolute floor', () => {
    expect(DEFAULT_VIEWER_OPTIONS).not.toHaveProperty('minZoomLevel');
    expect(DEFAULT_VIEWER_OPTIONS.minZoomImageRatio).toBeLessThanOrEqual(1);
    expect(DEFAULT_VIEWER_OPTIONS.minZoomImageRatio).toBeGreaterThan(0);
  });

  // Regression: an absolute `minZoomLevel: 0.5` sits above the home zoom of any
  // image taller than its cell, so OSD's `applyConstraints()` (which runs on
  // every mouse-up) zoomed in and then refused to zoom back out to fit.
  it.each([
    ['portrait image, wide cell', 0.5, 2],
    ['very tall image, wide cell', 0.25, 1.6],
    ['square image, wide cell', 1, 1.78],
    ['landscape image, narrow cell', 1.78, 1],
    ['landscape image, wide cell', 2, 2],
  ])('keeps the fit-the-image zoom reachable (%s)', (_label, imageAspect, containerAspect) => {
    const homeZoom = osdHomeZoom(imageAspect, containerAspect);
    const minZoom = osdMinZoom(DEFAULT_VIEWER_OPTIONS, homeZoom);

    expect(minZoom).toBeLessThanOrEqual(homeZoom);
  });

  // Regression: OSD's default `clickToZoom` zoomed the view by `zoomPerClick`
  // (2x) on every plain click in navigate mode.
  it('does not zoom on a plain click', () => {
    expect(DEFAULT_VIEWER_OPTIONS.gestureSettingsMouse.clickToZoom).toBe(false);
    expect(DEFAULT_VIEWER_OPTIONS.gestureSettingsMouse.dblClickToZoom).toBe(true);
  });

  it('still allows zooming out past the fitted image', () => {
    const homeZoom = osdHomeZoom(0.5, 2);

    expect(osdMinZoom(DEFAULT_VIEWER_OPTIONS, homeZoom)).toBeLessThan(homeZoom);
  });
});
