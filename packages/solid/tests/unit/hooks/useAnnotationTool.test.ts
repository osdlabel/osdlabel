import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import { createImageId } from '@osdlabel/viewer-api';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';
import { DEFAULT_KEYBOARD_SHORTCUTS } from '../../../src/hooks/useKeyboard.js';

// Mock useAnnotator
const mockActions = {
  updateAnnotation: vi.fn(),
  setActiveTool: vi.fn(),
  addAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  setSelectedAnnotation: vi.fn(),
};

const mockState = {
  uiState: {
    activeTool: 'select',
    activeViewerControl: null,
    activeCellIndex: 0,
    cellTransforms: {},
  },
  contextState: { activeContextId: 'ctx-1', contexts: [] },
  annotationState: { byImage: { 'img-1': { 'ann-1': { geometry: { type: 'rectangle' } } } } },
  constraintStatus: () => ({
    select: { enabled: true },
    rectangle: { enabled: true },
  }),
  actions: mockActions,
  activeToolKeyHandlerRef: { handler: null },
  shortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
};

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

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
interface MockOverlay {
  canvas: MockCanvas;
  setMode: ReturnType<typeof vi.fn>;
  screenToImage: ReturnType<typeof vi.fn>;
}

describe('useAnnotationTool', () => {
  // Structural stubs, not the real types: these stand in for a FabricOverlay
  // and its canvas, and only the members the hook touches are present.
  let mockOverlay: MockOverlay;
  let mockCanvas: MockCanvas;
  let listeners: Record<string, (...args: unknown[]) => unknown> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    listeners = {};
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
    mockOverlay = {
      canvas: mockCanvas,
      setMode: vi.fn(),
      screenToImage: vi.fn(),
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
});
