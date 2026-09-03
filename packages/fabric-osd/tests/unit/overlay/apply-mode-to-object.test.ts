import { describe, expect, it } from 'vitest';
import { Rect } from 'fabric';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type { OverlayMode } from '../../../src/overlay/fabric-overlay.js';

/**
 * `applyModeToObject` is the single authority on whether a Fabric object is
 * selectable and evented — `setMode` applies it to every object on the canvas,
 * and `ViewerCell` applies it to each object it rebuilds. Setting those flags
 * anywhere else is what silently undid `paint` mode on the first state change.
 *
 * Constructing a real `FabricOverlay` needs an OSD viewer, so the instance is
 * built from the prototype with only the field the method reads. That still
 * exercises the real implementation, which is the point: the sibling suite in
 * this directory reimplements `setMode` inside the test file and therefore
 * survives any mutation of the source.
 */
function overlayInMode(mode: OverlayMode): FabricOverlay {
  const overlay = Object.create(FabricOverlay.prototype) as FabricOverlay & { _mode: OverlayMode };
  overlay._mode = mode;
  return overlay;
}

const MODES: readonly OverlayMode[] = ['navigation', 'annotation', 'paint', 'customControl'];

describe('FabricOverlay.applyModeToObject', () => {
  it('makes an ordinary annotation interactive only in annotation mode', () => {
    for (const mode of MODES) {
      const obj = new Rect({ width: 1, height: 1 });
      overlayInMode(mode).applyModeToObject(obj, false);
      const expected = mode === 'annotation';
      expect({ mode, selectable: obj.selectable, evented: obj.evented }).toEqual({
        mode,
        selectable: expected,
        evented: expected,
      });
    }
  });

  it('keeps a read-only object inert in every mode, annotation included', () => {
    // Companion objects — decoration lines, the brush preview, the cursor ring
    // — carry `_readOnly` and must never become draggable.
    for (const mode of MODES) {
      const obj = new Rect({ width: 1, height: 1 });
      overlayInMode(mode).applyModeToObject(obj, true);
      expect({ mode, selectable: obj.selectable, evented: obj.evented }).toEqual({
        mode,
        selectable: false,
        evented: false,
      });
    }
  });

  it('leaves objects inert in paint mode, which is what stops a stroke dragging a shape', () => {
    const obj = new Rect({ width: 1, height: 1, selectable: true, evented: true });
    overlayInMode('paint').applyModeToObject(obj, false);
    expect(obj.selectable).toBe(false);
    expect(obj.evented).toBe(false);
  });
});
