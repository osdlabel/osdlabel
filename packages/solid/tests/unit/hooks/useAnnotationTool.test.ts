import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { AnnotationTool } from '@osdlabel/fabric-annotations';
import { version as FABRIC_VERSION } from 'fabric';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createMockAnnotator } from './mock-annotator.js';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';

/**
 * The annotator context the hook sees. Built through `createMockAnnotator` so
 * it is checked against the real context type — a plain object literal here is
 * not, because `vi.mock` factory returns are unchecked, and this mock had in
 * fact been running the hook with `vertexEditConfig` absent (#162).
 */
const mockState = createMockAnnotator({
  contextState: {
    activeContextId: createAnnotationContextId('ctx-1'),
    contexts: [],
    displayedContextIds: [],
  },
});
mockState.uiState.activeTool = 'select';
mockState.annotationState.byImage[createImageId('img-1')] = {
  [createAnnotationId('ann-1')]: {
    id: createAnnotationId('ann-1'),
    imageId: createImageId('img-1'),
    contextId: createAnnotationContextId('ctx-1'),
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
    rawAnnotationData: {
      format: 'fabric',
      fabricVersion: FABRIC_VERSION,
      data: { type: 'Rect', left: 0, top: 0, width: 10, height: 10 },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

const mockActions = mockState.actions;

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

/**
 * Every tool the hook builds, in order. `createAnnotationTool` is wrapped, not
 * replaced: the hook still gets a real tool, and the test can reach it.
 */
const createdTools: AnnotationTool[] = [];

vi.mock('osdlabel', async () => {
  const actual = (await vi.importActual('osdlabel')) as Record<string, unknown>;
  const realFactory = actual.createAnnotationTool as (...args: never[]) => AnnotationTool | null;
  return {
    ...actual,
    createAnnotationTool: (...args: never[]) => {
      const tool = realFactory(...args);
      if (tool) createdTools.push(tool);
      return tool;
    },
  };
});

vi.mock('@osdlabel/fabric-annotations', async () => {
  const actual = await vi.importActual('@osdlabel/fabric-annotations');
  return {
    ...(actual as Record<string, unknown>),
    getGeometryFromFabricObject: vi.fn().mockReturnValue({ type: 'rectangle' }),
    serializeFabricObject: vi.fn().mockReturnValue({}),
  };
});

/**
 * A Fabric-canvas stub. The hook itself only calls `on` and `off`; the rest are
 * here because the tools it activates reach through to them, and because the
 * stub predates this typing and dropping members would change what the tests
 * exercise.
 */
interface MockCanvas {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  requestRenderAll: ReturnType<typeof vi.fn>;
  discardActiveObject: ReturnType<typeof vi.fn>;
  getObjects: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
}

/**
 * An overlay stub, cast to `FabricOverlay` at the call site.
 *
 * The hook touches `canvas.on/off`, `setMode`, `screenToImage` and
 * `setCustomControlHandler`. The last is absent deliberately: these tests run
 * with `activeViewerControl: null`, so that branch is never entered, and adding
 * it would imply coverage that does not exist.
 */
type DoubleClickListener = (event: PointerEvent, imagePoint: { x: number; y: number }) => void;

interface MockOverlay {
  canvas: MockCanvas;
  setMode: ReturnType<typeof vi.fn>;
  screenToImage: ReturnType<typeof vi.fn>;
  onDoubleClick: ReturnType<typeof vi.fn>;
}

describe('useAnnotationTool', () => {
  // Structural stubs, not the real types: these stand in for a FabricOverlay
  // and its canvas, and only the members the hook touches are present.
  let mockOverlay: MockOverlay;
  let mockCanvas: MockCanvas;
  let listeners: Record<string, (...args: unknown[]) => unknown> = {};
  let doubleClickListeners: DoubleClickListener[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    listeners = {};
    createdTools.length = 0;
    mockCanvas = {
      on: vi.fn((e, cb) => {
        listeners[e] = cb;
      }),
      off: vi.fn((e, cb) => {
        if (listeners[e] === cb) delete listeners[e];
      }),
      setMode: vi.fn(),
      requestRenderAll: vi.fn(),
      discardActiveObject: vi.fn(),
      getObjects: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      add: vi.fn(),
    };
    doubleClickListeners = [];
    mockOverlay = {
      canvas: mockCanvas,
      setMode: vi.fn(),
      screenToImage: vi.fn(),
      // Mirrors FabricOverlay.onDoubleClick: registers and returns unsubscribe.
      onDoubleClick: vi.fn((cb: DoubleClickListener) => {
        doubleClickListeners.push(cb);
        return () => {
          doubleClickListeners = doubleClickListeners.filter((l) => l !== cb);
        };
      }),
    };
  });

  it('should register object:modified handler and update annotation', async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const [overlay] = createSignal(mockOverlay as unknown as FabricOverlay);
        const [imageId] = createSignal(createImageId('img-1'));
        const [isActive] = createSignal(true);

        useAnnotationTool(overlay, imageId, isActive);

        // Set tool to 'rectangle' to verify that object:modified is handled even when SelectTool is not active
        // This confirms the fix works as intended (independent of active tool)
        mockState.uiState.activeTool = 'rectangle';

        // Wait for effect to run
        setTimeout(() => {
          // Verify listener is registered
          expect(mockCanvas.on).toHaveBeenCalledWith('object:modified', expect.any(Function));

          // Simulate object:modified
          const handler = listeners['object:modified'];
          const mockObj = { id: 'ann-1', type: 'rect' };

          if (handler) {
            handler({ target: mockObj });
          }

          // Verify action called
          expect(mockActions.updateAnnotation).toHaveBeenCalledWith(
            'ann-1',
            'img-1',
            expect.objectContaining({
              geometry: expect.anything(),
              rawAnnotationData: expect.anything(),
            }),
          );

          dispose();
          resolve();
        }, 0);
      });
    });
  });

  /**
   * The hook is the only thing joining `FabricOverlay.onDoubleClick` to the
   * active tool. There is no Fabric canvas event to fall back on — see #168 —
   * so if this wiring is dropped the gesture silently stops working, which is
   * precisely the failure the issue describes.
   */
  it('routes the overlay double click to the active tool, and unsubscribes on cleanup', () => {
    return new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const [overlay] = createSignal(mockOverlay as unknown as FabricOverlay);
        const [imageId] = createSignal(createImageId('img-1'));
        const [isActive] = createSignal(true);

        useAnnotationTool(overlay, imageId, isActive);
        const previousTool = mockState.uiState.activeTool;
        mockState.uiState.activeTool = 'polyline';

        setTimeout(() => {
          try {
            expect(mockOverlay.onDoubleClick).toHaveBeenCalledWith(expect.any(Function));
            expect(doubleClickListeners).toHaveLength(1);

            // Drive a double click and assert it reaches the tool. Spying on
            // the real PolylineTool instance the hook built is what makes this
            // a wiring test rather than a test of the stub.
            const tool = createdTools.at(-1);
            expect(tool).toBeDefined();
            const spy = vi.spyOn(tool!, 'onDoubleClick');

            const point = { x: 12, y: 34 };
            const event = { type: 'pointerup' } as PointerEvent;
            doubleClickListeners[0]!(event, point);

            expect(spy).toHaveBeenCalledWith(event, point);

            dispose();
            // The subscription is released with the effect, so a later double
            // click cannot reach a deactivated tool.
            expect(doubleClickListeners).toHaveLength(0);
          } catch (error) {
            // Reject rather than let the assertion escape the timer callback,
            // where it would surface as a 5s timeout instead of a named failure.
            mockState.uiState.activeTool = previousTool;
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          // `mockState` is module-level; leaving it mutated would couple this
          // test to whatever runs after it.
          mockState.uiState.activeTool = previousTool;
          resolve();
        }, 0);
      });
    });
  });
});
