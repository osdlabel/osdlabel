import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FreeHandPathTool } from '../../../src/tools/free-hand-path-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../../src/tools/base-tool.js';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { Polyline, Polygon } from 'fabric';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

describe('FreeHandPathTool', () => {
  let tool: FreeHandPathTool;
  let mockOverlay: ToolOverlay;
  let mockCanvas: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    requestRenderAll: ReturnType<typeof vi.fn>;
    getZoom: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  let mockCallbacks: ToolCallbacks;
  let addedParams: AddAnnotationParams[];
  const imageId = createImageId('test-image');
  const contextId = createAnnotationContextId('test-context');
  const mockShortcuts: KeyboardShortcutMap = createTestKeyboardShortcuts();

  beforeEach(() => {
    vi.clearAllMocks();
    addedParams = [];

    mockCanvas = {
      add: vi.fn(),
      remove: vi.fn(),
      requestRenderAll: vi.fn(),
      getZoom: vi.fn().mockReturnValue(1),
      on: vi.fn(),
      off: vi.fn(),
    };

    mockOverlay = {
      canvas: mockCanvas,
      imageToScreen: vi.fn((p: { x: number; y: number }) => p),
    } as unknown as ToolOverlay;

    mockCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type }),
      canAddAnnotation: () => true,
      addAnnotation: (params) => {
        addedParams.push(params);
      },
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      getAnnotation: vi.fn().mockReturnValue(undefined),
    };
  });

  it('should create a closed polygon on mousedown, drag, mouseup', () => {
    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const downEvent = { type: 'pointerdown', shiftKey: false } as PointerEvent;
    tool.onPointerDown(downEvent, { x: 10, y: 10 });

    expect(mockCanvas.add).toHaveBeenCalledTimes(1);
    const preview = mockCanvas.add.mock.calls[0][0];
    expect(preview).toBeInstanceOf(Polyline);

    // Move to accumulate points
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 10, y: 50 });

    // Release — should create a closed polygon (default)
    tool.onPointerUp({ type: 'pointerup', shiftKey: false } as PointerEvent, { x: 10, y: 50 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;
    expect(params.type).toBe('freeHandPath');
    expect(params.fabricObject).toBeInstanceOf(Polygon);
    // preview removed + final added
    expect(mockCanvas.remove).toHaveBeenCalledTimes(1);
    expect(mockCanvas.add).toHaveBeenCalledTimes(2);
  });

  it('should create an open polyline when shift is held', () => {
    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown', shiftKey: true } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: true } as PointerEvent, { x: 50, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: true } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerUp({ type: 'pointerup', shiftKey: true } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;
    expect(params.type).toBe('freeHandPath');
    expect(params.fabricObject).toBeInstanceOf(Polyline);
    expect(params.fabricObject).not.toBeInstanceOf(Polygon);
  });

  it('should cancel on Escape during drawing', () => {
    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown', shiftKey: false } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 50 });

    const result = tool.onKeyDown({ key: 'Escape' } as KeyboardEvent);
    expect(result).toBe(true);
    expect(mockCanvas.remove).toHaveBeenCalledTimes(1);
    expect(addedParams).toHaveLength(0);
  });

  it('should cancel if too few points on mouseup (single click)', () => {
    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    // Click without dragging — only 1 point
    tool.onPointerDown({ type: 'pointerdown', shiftKey: false } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerUp({ type: 'pointerup', shiftKey: false } as PointerEvent, { x: 10, y: 10 });

    expect(addedParams).toHaveLength(0);
    expect(mockCanvas.remove).toHaveBeenCalledTimes(1);
  });

  it('should not sample points that are too close together', () => {
    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown', shiftKey: false } as PointerEvent, { x: 10, y: 10 });

    // Move only 1 pixel — should be ignored (below default threshold of 3)
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 11, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 11, y: 11 });

    // Move far enough
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 50 });

    const preview = mockCanvas.add.mock.calls[0][0];
    // Should have initial point + one far point + current cursor = 3 points
    expect(preview.points.length).toBe(3);
  });

  it('should respect a custom minSampleDistancePx', () => {
    tool = new FreeHandPathTool({ minSampleDistancePx: 20 });
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown', shiftKey: false } as PointerEvent, { x: 0, y: 0 });

    // Move 10px — below custom threshold of 20, should be ignored
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 10, y: 0 });

    // Move 25px total — above threshold, should be sampled
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 25, y: 0 });

    const preview = mockCanvas.add.mock.calls[0][0];
    expect(preview.points.length).toBe(3); // initial + one sampled point + current cursor
  });

  it('should not create annotation when no active context', () => {
    const noContextCallbacks: ToolCallbacks = {
      ...mockCallbacks,
      getActiveContextId: () => null,
    };

    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, noContextCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown', shiftKey: false } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 10, y: 50 });
    tool.onPointerUp({ type: 'pointerup', shiftKey: false } as PointerEvent, { x: 10, y: 50 });

    expect(addedParams).toHaveLength(0);
  });

  it('should not consume Escape when not drawing', () => {
    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const result = tool.onKeyDown({ key: 'Escape' } as KeyboardEvent);
    expect(result).toBe(false);
  });

  it('should not create annotation when constraint disallows it', () => {
    const constrainedCallbacks: ToolCallbacks = {
      ...mockCallbacks,
      canAddAnnotation: () => false,
    };

    tool = new FreeHandPathTool();
    tool.activate(mockOverlay, imageId, constrainedCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown', shiftKey: false } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 10 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerMove({ type: 'pointermove', shiftKey: false } as PointerEvent, { x: 10, y: 50 });
    tool.onPointerUp({ type: 'pointerup', shiftKey: false } as PointerEvent, { x: 10, y: 50 });

    expect(addedParams).toHaveLength(0);
  });
});
