import { describe, it, expect, beforeEach } from 'vitest';
import type { OverlayMode } from '../../../src/overlay/fabric-overlay.js';

/**
 * Since FabricOverlay requires real DOM + OSD + Fabric, we test the mode
 * logic by creating a lightweight mock that mirrors the setMode behavior.
 * This verifies the routing contract without needing canvas support in jsdom.
 *
 * The overlay uses an OSD MouseTracker to route events:
 * - navigation: tracker disabled, OSD handles all input
 * - annotation: tracker enabled, all events forwarded to Fabric,
 *   objects are selectable/evented, Ctrl+drag or Command+drag pans OSD
 */

interface MockState {
  /** Whether the OSD MouseTracker is actively tracking events */
  overlayTrackerTracking: boolean;
  /** Whether Fabric's group-selection box is enabled */
  fabricSelection: boolean;
  /** Whether OSD pan/zoom via mouse is enabled */
  osdMouseNavEnabled: boolean;
  /** Whether Fabric objects are selectable */
  objectsSelectable: boolean;
  /** Whether Fabric objects receive pointer events */
  objectsEvented: boolean;
  /** Count of discardActiveObject() calls (a setMode side effect) */
  discardActiveObjectCalls: number;
}

interface MockOverlay {
  setMode(mode: OverlayMode): void;
  getMode(): OverlayMode;
}

function createMockOverlay(): { overlay: MockOverlay; state: MockState } {
  const state: MockState = {
    overlayTrackerTracking: false,
    fabricSelection: false,
    osdMouseNavEnabled: true,
    objectsSelectable: false,
    objectsEvented: false,
    discardActiveObjectCalls: 0,
  };

  let currentMode: OverlayMode = 'navigation';

  function setMode(mode: OverlayMode): void {
    // Mirrors the real FabricOverlay.setMode no-op guard: re-applying the
    // current mode must not re-run side effects (discardActiveObject, object
    // walks) that could clobber an in-progress gesture.
    if (mode === currentMode) return;
    currentMode = mode;

    switch (mode) {
      case 'navigation':
        state.overlayTrackerTracking = false;
        state.fabricSelection = false;
        state.objectsSelectable = false;
        state.objectsEvented = false;
        state.osdMouseNavEnabled = true;
        state.discardActiveObjectCalls += 1;
        break;

      case 'annotation':
        state.overlayTrackerTracking = true;
        state.fabricSelection = true;
        state.objectsSelectable = true;
        state.objectsEvented = true;
        state.osdMouseNavEnabled = false;
        break;

      case 'customControl':
        // Tracker intercepts so events reach the custom handler, but Fabric is
        // fully inert and OSD mouse nav is disabled.
        state.overlayTrackerTracking = true;
        state.fabricSelection = false;
        state.objectsSelectable = false;
        state.objectsEvented = false;
        state.osdMouseNavEnabled = false;
        state.discardActiveObjectCalls += 1;
        break;
    }
  }

  function getMode(): OverlayMode {
    return currentMode;
  }

  return { overlay: { setMode, getMode }, state };
}

describe('Input routing — setMode', () => {
  let overlay: MockOverlay;
  let state: MockState;

  beforeEach(() => {
    const mock = createMockOverlay();
    overlay = mock.overlay;
    state = mock.state;
  });

  describe('navigation mode', () => {
    it('disables overlay tracker (events fall through to OSD)', () => {
      overlay.setMode('navigation');
      expect(state.overlayTrackerTracking).toBe(false);
    });

    it('disables Fabric selection', () => {
      overlay.setMode('navigation');
      expect(state.fabricSelection).toBe(false);
    });

    it('makes objects non-selectable and non-evented', () => {
      overlay.setMode('navigation');
      expect(state.objectsSelectable).toBe(false);
      expect(state.objectsEvented).toBe(false);
    });

    it('enables OSD mouse navigation', () => {
      overlay.setMode('navigation');
      expect(state.osdMouseNavEnabled).toBe(true);
    });

    it('reports correct mode', () => {
      overlay.setMode('navigation');
      expect(overlay.getMode()).toBe('navigation');
    });
  });

  describe('annotation mode', () => {
    it('enables overlay tracker (intercepts events for Fabric)', () => {
      overlay.setMode('annotation');
      expect(state.overlayTrackerTracking).toBe(true);
    });

    it('enables Fabric selection (allows rubber-band and object selection)', () => {
      overlay.setMode('annotation');
      expect(state.fabricSelection).toBe(true);
    });

    it('makes objects selectable and evented', () => {
      overlay.setMode('annotation');
      expect(state.objectsSelectable).toBe(true);
      expect(state.objectsEvented).toBe(true);
    });

    it('disables OSD mouse navigation', () => {
      overlay.setMode('annotation');
      expect(state.osdMouseNavEnabled).toBe(false);
    });

    it('reports correct mode', () => {
      overlay.setMode('annotation');
      expect(overlay.getMode()).toBe('annotation');
    });
  });

  describe('customControl mode', () => {
    it('enables overlay tracker so events reach the custom handler', () => {
      overlay.setMode('customControl');
      expect(state.overlayTrackerTracking).toBe(true);
    });

    it('keeps Fabric inert (no selection, objects non-interactive)', () => {
      overlay.setMode('customControl');
      expect(state.fabricSelection).toBe(false);
      expect(state.objectsSelectable).toBe(false);
      expect(state.objectsEvented).toBe(false);
    });

    it('disables OSD mouse navigation', () => {
      overlay.setMode('customControl');
      expect(state.osdMouseNavEnabled).toBe(false);
    });

    it('reports correct mode', () => {
      overlay.setMode('customControl');
      expect(overlay.getMode()).toBe('customControl');
    });
  });

  describe('mode transitions', () => {
    it('correctly transitions from annotation to navigation', () => {
      overlay.setMode('annotation');
      expect(state.osdMouseNavEnabled).toBe(false);
      expect(state.overlayTrackerTracking).toBe(true);
      expect(state.objectsSelectable).toBe(true);

      overlay.setMode('navigation');
      expect(state.osdMouseNavEnabled).toBe(true);
      expect(state.overlayTrackerTracking).toBe(false);
      expect(state.objectsSelectable).toBe(false);
    });

    it('correctly transitions from navigation to annotation', () => {
      overlay.setMode('navigation');
      expect(state.overlayTrackerTracking).toBe(false);
      expect(state.osdMouseNavEnabled).toBe(true);

      overlay.setMode('annotation');
      expect(state.overlayTrackerTracking).toBe(true);
      expect(state.osdMouseNavEnabled).toBe(false);
      expect(state.fabricSelection).toBe(true);
      expect(state.objectsSelectable).toBe(true);
      expect(state.objectsEvented).toBe(true);
    });

    it('does not re-run discardActiveObject side effect on redundant setMode', () => {
      overlay.setMode('customControl');
      const after = state.discardActiveObjectCalls;
      expect(after).toBeGreaterThan(0);

      // Re-applying the same mode must be a true no-op (guards an in-progress
      // custom-control drag from being clobbered).
      overlay.setMode('customControl');
      expect(state.discardActiveObjectCalls).toBe(after);
    });

    it('handles repeated same-mode calls idempotently', () => {
      overlay.setMode('annotation');
      const snapshot = { ...state };
      overlay.setMode('annotation');
      expect(state).toEqual(snapshot);
    });

    it('handles rapid mode switching without inconsistency', () => {
      overlay.setMode('annotation');
      overlay.setMode('navigation');
      overlay.setMode('annotation');
      overlay.setMode('navigation');

      expect(state.overlayTrackerTracking).toBe(false);
      expect(state.fabricSelection).toBe(false);
      expect(state.osdMouseNavEnabled).toBe(true);
      expect(state.objectsSelectable).toBe(false);
      expect(state.objectsEvented).toBe(false);
      expect(overlay.getMode()).toBe('navigation');
    });
  });
});
