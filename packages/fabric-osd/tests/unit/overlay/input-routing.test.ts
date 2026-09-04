import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rect } from 'fabric';
import type { FabricObject } from 'fabric';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type { OverlayMode } from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, type TestViewer } from './test-viewer.js';

/**
 * Whether the overlay's OSD MouseTracker is intercepting pointer events.
 * The tracker is private, but whether it is armed *is* the observable contract
 * of each mode — it decides whether input reaches Fabric or falls through to
 * OSD — so read it rather than leave the three `setTracking` calls uncovered.
 */
function isTracking(overlay: FabricOverlay): boolean {
  return (
    overlay as unknown as { _overlayTracker: { isTracking(): boolean } }
  )._overlayTracker.isTracking();
}

/**
 * These tests drive the real `FabricOverlay`. The previous version of this file
 * defined a `createMockOverlay()` that reimplemented `setMode` in the test and
 * asserted against the reimplementation — its only import from source was
 * `import type { OverlayMode }`, which is erased at runtime, so replacing
 * `setMode`'s entire body with `this._mode = mode` left all 19 tests green.
 *
 * Only the OpenSeadragon viewer is stubbed (see `test-viewer.ts`); the overlay,
 * its Fabric canvas and its mode switching are the genuine article.
 */
describe('FabricOverlay mode switching', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;

  beforeEach(() => {
    tv = createTestViewer();
    overlay = new FabricOverlay(tv.viewer);
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
  });

  /** Adds a plain annotation-like object to the overlay's canvas. */
  function addObject(readOnly = false): FabricObject {
    const rect = new Rect({ left: 0, top: 0, width: 10, height: 10 });
    if (readOnly) rect._readOnly = true;
    overlay.canvas.add(rect);
    return rect;
  }

  it('starts in navigation mode', () => {
    expect(overlay.getMode()).toBe('navigation');
  });

  it.each<OverlayMode>(['navigation', 'annotation', 'customControl'])(
    'getMode reports %s after setMode',
    (mode) => {
      // A different mode first, so setting `navigation` is not a no-op.
      overlay.setMode(mode === 'navigation' ? 'annotation' : 'navigation');
      overlay.setMode(mode);
      expect(overlay.getMode()).toBe(mode);
    },
  );

  describe('annotation mode', () => {
    it('enables canvas selection and hands input to Fabric', () => {
      overlay.setMode('annotation');
      expect(overlay.canvas.selection).toBe(true);
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(false);
      expect(isTracking(overlay)).toBe(true);
    });

    it('makes ordinary objects interactive', () => {
      const obj = addObject();
      overlay.setMode('annotation');
      expect(obj.selectable).toBe(true);
      expect(obj.evented).toBe(true);
    });

    // The branch the old in-test mock never modelled: it set a single
    // `objectsSelectable = true` for the whole canvas, so the entire read-only
    // path — decoration lines, other contexts' annotations — was untested.
    it('leaves _readOnly objects inert', () => {
      const readOnly = addObject(true);
      const normal = addObject();
      overlay.setMode('annotation');
      expect(readOnly.selectable).toBe(false);
      expect(readOnly.evented).toBe(false);
      expect(normal.selectable).toBe(true);
      expect(normal.evented).toBe(true);
    });

    it('does not discard the active object', () => {
      const spy = vi.spyOn(overlay.canvas, 'discardActiveObject');
      overlay.setMode('annotation');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('navigation mode', () => {
    it('disables selection and returns input to OSD', () => {
      overlay.setMode('annotation');
      overlay.setMode('navigation');
      expect(overlay.canvas.selection).toBe(false);
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(true);
      // Tracker disarmed: pointer events fall through to OSD.
      expect(isTracking(overlay)).toBe(false);
    });

    it('makes every object inert, including ones that were interactive', () => {
      const obj = addObject();
      overlay.setMode('annotation');
      expect(obj.selectable).toBe(true);
      overlay.setMode('navigation');
      expect(obj.selectable).toBe(false);
      expect(obj.evented).toBe(false);
    });

    it('discards the active object', () => {
      overlay.setMode('annotation');
      const spy = vi.spyOn(overlay.canvas, 'discardActiveObject');
      overlay.setMode('navigation');
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('customControl mode', () => {
    it('disables selection and keeps OSD navigation off', () => {
      overlay.setMode('customControl');
      expect(overlay.canvas.selection).toBe(false);
      // Distinguishes customControl from navigation: neither OSD nor Fabric
      // reacts, so mouse nav stays disabled rather than being handed back, and
      // the tracker stays armed so events reach the custom handler.
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(false);
      expect(isTracking(overlay)).toBe(true);
    });

    it('makes every object inert regardless of _readOnly', () => {
      const readOnly = addObject(true);
      const normal = addObject();
      overlay.setMode('annotation');
      expect(normal.selectable).toBe(true);
      overlay.setMode('customControl');
      expect(normal.selectable).toBe(false);
      expect(normal.evented).toBe(false);
      expect(readOnly.selectable).toBe(false);
    });

    it('discards the active object', () => {
      const spy = vi.spyOn(overlay.canvas, 'discardActiveObject');
      overlay.setMode('customControl');
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('transitions', () => {
    it('is a no-op when the mode is unchanged', () => {
      overlay.setMode('annotation');
      const callsAfterFirst = tv.setMouseNavEnabled.mock.calls.length;
      const spy = vi.spyOn(overlay.canvas, 'renderAll');

      overlay.setMode('annotation');

      expect(tv.setMouseNavEnabled.mock.calls.length).toBe(callsAfterFirst);
      expect(spy).not.toHaveBeenCalled();
    });

    it('renders after a real mode change', () => {
      const spy = vi.spyOn(overlay.canvas, 'renderAll');
      overlay.setMode('annotation');
      expect(spy).toHaveBeenCalled();
    });

    it.each<[OverlayMode, OverlayMode]>([
      ['navigation', 'annotation'],
      ['annotation', 'customControl'],
      ['customControl', 'navigation'],
      ['navigation', 'customControl'],
      ['customControl', 'annotation'],
      ['annotation', 'navigation'],
    ])('applies %s -> %s', (from, to) => {
      overlay.setMode(from);
      const obj = addObject();
      overlay.setMode(to);

      expect(overlay.getMode()).toBe(to);
      expect(overlay.canvas.selection).toBe(to === 'annotation');
      expect(obj.selectable).toBe(to === 'annotation');
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(to === 'navigation');
      expect(isTracking(overlay)).toBe(to !== 'navigation');
    });
  });

  describe('construction', () => {
    it('honours the interactive option by starting in annotation mode', () => {
      const other = createTestViewer();
      const interactive = new FabricOverlay(other.viewer, { interactive: true });
      expect(interactive.getMode()).toBe('annotation');
      expect(other.setMouseNavEnabled).toHaveBeenCalledWith(false);
      interactive.destroy();
      other.cleanup();
    });
  });
});
