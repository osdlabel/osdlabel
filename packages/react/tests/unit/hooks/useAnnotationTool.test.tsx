import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { AnnotationTool, ToolCallbacks } from '@osdlabel/fabric-annotations';
import { createAnnotationId, type Geometry } from '@osdlabel/annotation';
import { createImageId, type ImageId } from '@osdlabel/viewer-api';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';
import { renderAnnotator, type AnnotatorHarness, type ProviderProps } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { byImage, contextId, imageId, rect } from '../fixtures.js';

/**
 * The React counterpart of Solid's `hooks/useAnnotationTool.test.ts`, run
 * against a real `AnnotatorProvider` rather than a mocked context.
 *
 * React-specific, and the reason this file is larger than its Solid twin: the
 * hook's main effect builds a tool, and React re-runs an effect whenever a
 * dependency's identity changes. Rebuilding the tool deactivates the old one,
 * which throws away anything in progress — an unfinished polyline, a vertex
 * edit. So the tool must survive a host re-render that passes equal-valued
 * inline props, and must be rebuilt when one of its real inputs changes. The
 * long-lived Fabric handlers read state through refs, so they must also see
 * state committed after they were registered.
 */

/** One entry per tool the hook built, in order. */
interface BuiltTool {
  readonly tool: AnnotationTool;
  readonly deactivate: Mock<() => void>;
  /** The callbacks the hook handed `tool.activate`. */
  callbacks: ToolCallbacks | undefined;
}
const built: BuiltTool[] = [];

vi.mock('osdlabel', async () => {
  const actual = await vi.importActual<typeof import('osdlabel')>('osdlabel');
  return {
    ...actual,
    // Wrapped, not replaced: the hook still gets a real tool.
    createAnnotationTool: (...args: Parameters<typeof actual.createAnnotationTool>) => {
      const tool = actual.createAnnotationTool(...args);
      if (tool) {
        const entry: BuiltTool = {
          tool,
          deactivate: vi.fn<() => void>(tool.deactivate.bind(tool)),
          callbacks: undefined,
        };
        const activate = tool.activate.bind(tool);
        tool.activate = (overlay, img, callbacks, shortcuts) => {
          entry.callbacks = callbacks;
          activate(overlay, img, callbacks, shortcuts);
        };
        tool.deactivate = entry.deactivate;
        built.push(entry);
      }
      return tool;
    },
  };
});

/** What `getGeometryFromFabricObject` returns for the next `object:modified`. */
const movedGeometry: Geometry = {
  type: 'rectangle',
  origin: { x: 5, y: 6 },
  width: 30,
  height: 40,
  rotation: 0,
};

vi.mock('@osdlabel/fabric-annotations', async () => {
  const actual = await vi.importActual<typeof import('@osdlabel/fabric-annotations')>(
    '@osdlabel/fabric-annotations',
  );
  return {
    ...actual,
    getGeometryFromFabricObject: vi.fn(() => movedGeometry),
    serializeFabricObject: vi.fn(() => ({
      format: 'fabric',
      fabricVersion: 'test',
      data: { type: 'Rect' },
    })),
  };
});

type Listener = (...args: unknown[]) => unknown;
type DoubleClickListener = (
  event: PointerEvent,
  imagePoint: { x: number; y: number },
  pressSeqs?: readonly [number, number],
) => void;

/** Structural stand-in for the overlay: only what the hook and the real tools touch. */
function createMockOverlay() {
  const listeners = new Map<string, Set<Listener>>();
  let doubleClickListeners: DoubleClickListener[] = [];
  const canvas = {
    on: vi.fn((event: string, cb: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(cb);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, cb: Listener) => {
      listeners.get(event)?.delete(cb);
    }),
    requestRenderAll: vi.fn(),
    discardActiveObject: vi.fn(),
    getObjects: vi.fn(() => []),
    remove: vi.fn(),
    add: vi.fn(),
  };
  const overlay = {
    canvas,
    setMode: vi.fn(),
    setCustomControlHandler: vi.fn(),
    screenToImage: vi.fn((p: { x: number; y: number }) => p),
    imageToScreen: vi.fn((p: { x: number; y: number }) => p),
    pressSeqOf: vi.fn(() => undefined),
    onDoubleClick: vi.fn((cb: DoubleClickListener) => {
      doubleClickListeners.push(cb);
      return () => {
        doubleClickListeners = doubleClickListeners.filter((l) => l !== cb);
      };
    }),
  };
  return {
    overlay,
    asOverlay: overlay as unknown as FabricOverlay,
    /** Fires every listener registered for `event`, inside `act`. */
    fire(event: string, payload: unknown): void {
      act(() => {
        for (const cb of listeners.get(event) ?? []) cb(payload);
      });
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    doubleClickListeners: () => doubleClickListeners,
  };
}

type MockOverlay = ReturnType<typeof createMockOverlay>;

function ToolHost(props: {
  readonly overlay: FabricOverlay | undefined;
  readonly imageId: ImageId | undefined;
  readonly isActive: boolean;
}) {
  useAnnotationTool(props.overlay, props.imageId, props.isActive);
  return null;
}

describe('useAnnotationTool', () => {
  let mo: MockOverlay;

  beforeEach(() => {
    built.length = 0;
    mo = createMockOverlay();
  });

  afterEach(unmountAll);

  const host = (overrides: Partial<Parameters<typeof ToolHost>[0]> = {}) => (
    <ToolHost overlay={mo.asOverlay} imageId={imageId} isActive {...overrides} />
  );

  /** A provider with a context allowing every tool, the given tool active. */
  function setup(
    tool: 'select' | 'polyline' | 'rectangle' = 'polyline',
    props: ProviderProps = {},
  ): AnnotatorHarness {
    const h = renderAnnotator(props, host());
    h.run((a) => {
      a.assignImageToCell(0, imageId);
      a.setContexts([
        {
          id: contextId,
          label: 'All',
          tools: [{ type: 'rectangle' }, { type: 'circle' }, { type: 'polyline' }],
        },
      ]);
      a.setActiveContext(contextId);
      a.setActiveTool(tool);
    });
    return h;
  }

  it('should register object:modified handler and update annotation', () => {
    const h = setup('rectangle', { initialAnnotations: byImage(rect('ann-1')) });
    expect(mo.overlay.canvas.on).toHaveBeenCalledWith('object:modified', expect.any(Function));

    mo.fire('object:modified', { target: { id: 'ann-1' } });

    const ann = h.current.annotationState.byImage[imageId]?.[createAnnotationId('ann-1')];
    expect(ann).toBeDefined();
    expect(ann!.geometry).toEqual(movedGeometry);
  });

  it('object:modified sees an annotation added after the handler was registered', () => {
    // The handler is registered once per overlay/image and reads
    // `annotationStateRef.current`; a stale ref would find nothing to update.
    const h = setup('select');
    h.run((a) => a.addAnnotation(rect('late')));

    mo.fire('object:modified', { target: { id: 'late' } });

    expect(
      h.current.annotationState.byImage[imageId]![createAnnotationId('late')]!.geometry,
    ).toEqual(movedGeometry);
    // Fresh through the ref, not by re-registering on every state change.
    const registrations = mo.overlay.canvas.on.mock.calls.filter(([e]) => e === 'object:modified');
    expect(registrations).toHaveLength(1);
  });

  /**
   * The hook is the only thing joining `FabricOverlay.onDoubleClick` to the
   * active tool (#168), and the press pair must be relayed (#176).
   */
  it('routes the overlay double click to the active tool, and unsubscribes on cleanup', () => {
    const h = setup('polyline');
    expect(mo.overlay.onDoubleClick).toHaveBeenCalledWith(expect.any(Function));
    expect(mo.doubleClickListeners()).toHaveLength(1);

    const entry = built.at(-1);
    expect(entry).toBeDefined();
    expect(entry!.tool.type).toBe('polyline');
    const spy = vi.spyOn(entry!.tool, 'onDoubleClick');

    const point = { x: 12, y: 34 };
    const event = { type: 'pointerup' } as PointerEvent;
    const pressSeqs = [7, 8] as const;
    mo.doubleClickListeners()[0]!(event, point, pressSeqs);

    expect(spy).toHaveBeenCalledWith(event, point, pressSeqs);

    h.unmount();
    expect(mo.doubleClickListeners()).toHaveLength(0);
  });

  describe('is not rebuilt when the host merely re-renders', () => {
    /**
     * Each case re-renders the provider with a prop whose value is equal but
     * whose identity is new — what a host writing it inline does on every
     * render of its own. The `brushOptions` regression in #152 was exactly
     * this shape: an inline object in the tool effect's dependencies.
     */
    const inlineProps: Record<string, () => ProviderProps> = {
      keyboardShortcuts: () => ({ keyboardShortcuts: { rectangleTool: 'b' } }),
      vertexMarkers: () => ({ vertexMarkers: { radius: 4, color: '#f00' } }),
      onAnnotationsChange: () => ({ onAnnotationsChange: () => {} }),
      onConstraintChange: () => ({ onConstraintChange: () => {} }),
      onAnnotationRenderError: () => ({ onAnnotationRenderError: () => {} }),
      decorationProviders: () => ({ decorationProviders: [] }),
      shouldSkipKeyboardShortcutPredicate: () => ({
        shouldSkipKeyboardShortcutPredicate: () => false,
      }),
      defaultPixelSpacing: () => ({ defaultPixelSpacing: { x: 0.5, y: 0.5, unit: 'mm' } }),
    };

    for (const [name, make] of Object.entries(inlineProps)) {
      it(`with an inline \`${name}\``, () => {
        const h = setup('polyline', make());
        expect(built).toHaveLength(1);

        h.rerender(make(), host());
        h.rerender(make(), host());

        expect(built).toHaveLength(1);
        expect(built[0]!.deactivate).not.toHaveBeenCalled();
      });
    }

    it('when annotation, selection or view state changes', () => {
      const h = setup('polyline');
      h.run((a) => a.addAnnotation(rect('r1')));
      h.run((a) => a.setSelectedAnnotation(createAnnotationId('r1')));
      h.run((a) => a.rotateActiveImageCW());
      h.run((a) => a.setDisplayedContexts([contextId]));

      expect(built).toHaveLength(1);
      expect(built[0]!.deactivate).not.toHaveBeenCalled();
    });
  });

  describe('is rebuilt when a real input changes', () => {
    /** Asserts exactly one rebuild: the first tool deactivated, a second built. */
    function expectRebuiltOnce(): void {
      expect(built).toHaveLength(2);
      expect(built[0]!.deactivate).toHaveBeenCalledTimes(1);
      expect(built[1]!.deactivate).not.toHaveBeenCalled();
    }

    it('the active tool', () => {
      const h = setup('polyline');
      h.run((a) => a.setActiveTool('rectangle'));
      expectRebuiltOnce();
      expect(built[1]!.tool.type).toBe('rectangle');
    });

    it('the image', () => {
      const h = setup('polyline');
      h.rerender({}, host({ imageId: createImageId('img2') }));
      expectRebuiltOnce();
    });

    it('the overlay', () => {
      const h = setup('polyline');
      // The hook and the tool both listen for presses; all of them move.
      const presses = mo.listenerCount('mouse:down');
      expect(presses).toBeGreaterThan(0);
      const other = createMockOverlay();
      h.rerender({}, host({ overlay: other.asOverlay }));
      expectRebuiltOnce();
      expect(mo.listenerCount('mouse:down')).toBe(0);
      expect(other.listenerCount('mouse:down')).toBe(presses);
    });

    // Solid covers these three in `useAnnotationTool.config.test.ts` (#219).
    it('the vertex-marker values', () => {
      const h = setup('polyline', { vertexMarkers: { radius: 4 } });
      h.rerender({ vertexMarkers: { radius: 6 } }, host());
      expectRebuiltOnce();
    });

    it('the vertex-edit tuning', () => {
      const h = setup('polyline', { vertexEditLongPressMs: 500 });
      h.rerender({ vertexEditLongPressMs: 900 }, host());
      expectRebuiltOnce();
    });

    it('the shortcut values', () => {
      const h = setup('polyline', { keyboardShortcuts: { polylineFinish: 'Enter' } });
      h.rerender({ keyboardShortcuts: { polylineFinish: 'f' } }, host());
      expectRebuiltOnce();
    });

    it('the cell going inactive, and active again', () => {
      const h = setup('polyline');
      h.rerender({}, host({ isActive: false }));
      expect(built).toHaveLength(1);
      expect(built[0]!.deactivate).toHaveBeenCalledTimes(1);
      expect(mo.overlay.setMode).toHaveBeenLastCalledWith('navigation');

      h.rerender({}, host({ isActive: true }));
      expect(built).toHaveLength(2);
      expect(mo.overlay.setMode).toHaveBeenLastCalledWith('annotation');
    });

    it('a viewer control taking over the drag', () => {
      const h = setup('polyline');
      h.run((a) => a.setActiveViewerControl('tone'));

      expect(built).toHaveLength(1);
      expect(built[0]!.deactivate).toHaveBeenCalledTimes(1);
      expect(mo.overlay.setMode).toHaveBeenLastCalledWith('customControl');
      expect(mo.overlay.setCustomControlHandler).toHaveBeenLastCalledWith(expect.anything());
    });
  });

  describe('the surviving tool sees fresh state through its callbacks', () => {
    it('canAddAnnotation follows the constraint status', () => {
      // The select tool, so filling the rectangle limit does not trip the
      // auto-switch and rebuild the tool under test.
      const h = setup('select');
      h.run((a) =>
        a.setContexts([
          { id: contextId, label: 'One', tools: [{ type: 'rectangle', maxCount: 1 }] },
        ]),
      );
      const callbacks = built.at(-1)!.callbacks;
      expect(callbacks).toBeDefined();
      expect(callbacks!.canAddAnnotation('rectangle')).toBe(true);

      h.run((a) => a.addAnnotation(rect('r1')));

      expect(built).toHaveLength(1);
      expect(callbacks!.canAddAnnotation('rectangle')).toBe(false);
    });

    it('getAnnotation and getActiveContextId read the latest commit', () => {
      const h = setup('select');
      const callbacks = built.at(-1)!.callbacks;
      expect(callbacks).toBeDefined();

      h.run((a) => a.addAnnotation(rect('r1')));
      h.run((a) => a.setActiveContext(null));

      expect(built).toHaveLength(1);
      expect(callbacks!.getAnnotation(createAnnotationId('r1'), imageId)).toBeDefined();
      expect(callbacks!.getActiveContextId()).toBeNull();
    });

    it('getToolConstraint reads the latest contexts', () => {
      const h = setup('rectangle');
      const callbacks = built.at(-1)!.callbacks;
      expect(callbacks).toBeDefined();

      h.run((a) =>
        a.setContexts([
          { id: contextId, label: 'All', tools: [{ type: 'rectangle', maxCount: 7 }] },
        ]),
      );

      expect(built).toHaveLength(1);
      expect(callbacks!.getToolConstraint('rectangle')?.maxCount).toBe(7);
    });
  });

  it('switches to select when the active drawing tool becomes disabled', () => {
    const h = setup('rectangle');
    h.run((a) =>
      a.setContexts([{ id: contextId, label: 'One', tools: [{ type: 'rectangle', maxCount: 1 }] }]),
    );
    expect(h.current.uiState.activeTool).toBe('rectangle');

    h.run((a) => a.addAnnotation(rect('r1')));

    expect(h.current.uiState.activeTool).toBe('select');
  });

  it('claims the shared key-handler slot, and releases it on cleanup', () => {
    const h = setup('polyline');
    const slot = h.current.activeToolKeyHandlerRef;
    expect(slot.handler).toEqual(expect.any(Function));

    h.rerender({}, host({ isActive: false }));

    expect(slot.handler).toBeNull();
  });
});
