import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, type TestViewer } from './test-viewer.js';

/**
 * `replaceDrawer` against a stub of what OSD 5's `requestDrawer` does to the
 * DOM: destroy the old drawer (removing its canvas) and append the new
 * drawer's canvas to `viewer.canvas`, after anything already there.
 */
describe('FabricOverlay.replaceDrawer', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let requestDrawer: ReturnType<typeof vi.fn>;
  let viewer: { canvas: HTMLElement; drawer: { canvas: HTMLCanvasElement } };

  beforeEach(() => {
    tv = createTestViewer();
    viewer = tv.viewer as unknown as typeof viewer;
    // OSD puts its drawer canvas in first, before the overlay exists.
    tv.container.prepend(viewer.drawer.canvas);
    requestDrawer = vi.fn((candidate: unknown) => {
      if (candidate === 'html') return false;
      viewer.drawer.canvas.remove();
      const canvas = document.createElement('canvas');
      viewer.canvas.appendChild(canvas); // what DrawerBase's constructor does
      viewer.drawer = { canvas };
      return viewer.drawer;
    });
    (tv.viewer as unknown as { requestDrawer: typeof requestDrawer }).requestDrawer = requestDrawer;
    overlay = new FabricOverlay(tv.viewer);
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
  });

  it('keeps the new drawer canvas under the overlay', () => {
    expect(overlay.replaceDrawer('canvas')).toBe(true);
    expect(tv.container.firstElementChild).toBe(viewer.drawer.canvas);
    expect(requestDrawer).toHaveBeenCalledWith('canvas', {
      mainDrawer: true,
      redrawImmediately: true,
    });
  });

  it('carries the tone filter over to the new drawer', () => {
    overlay.applyImageFilters({ exposure: 0.5, contrast: 0, inverted: true });
    overlay.replaceDrawer('canvas');
    expect(viewer.drawer.canvas.style.filter).toBe('brightness(1.5) invert(1)');
  });

  it('reports an unsupported drawer and leaves the old one', () => {
    const before = viewer.drawer.canvas;
    expect(overlay.replaceDrawer('html')).toBe(false);
    expect(viewer.drawer.canvas).toBe(before);
  });
});
