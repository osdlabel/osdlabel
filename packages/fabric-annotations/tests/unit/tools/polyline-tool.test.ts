import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolylineTool } from '../../../src/tools/polyline-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../../src/tools/base-tool.js';
import { createImageId } from '@osdlabel/annotation';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { Polyline, Polygon } from 'fabric';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

describe('PolylineTool', () => {
  let tool: PolylineTool;
  let mockOverlay: ToolOverlay;
  let mockCanvas: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    requestRenderAll: ReturnType<typeof vi.fn>;
    getZoom: ReturnType<typeof vi.fn>;
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

  it('should start a preview path on first pointer down', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const event = { type: 'pointerdown' } as PointerEvent;
    tool.onPointerDown(event, { x: 10, y: 10 });

    expect(mockCanvas.add).toHaveBeenCalled();
    const addedObj = mockCanvas.add.mock.calls[0][0];
    expect(addedObj).toBeInstanceOf(Polyline);
    expect(addedObj.points.length).toBe(2);
    expect(addedObj.points[0]).toEqual({ x: 10, y: 10 });
    expect(addedObj.points[1]).toEqual({ x: 10, y: 10 });
  });

  it('should update the cursor point on pointer move', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

    const preview = mockCanvas.add.mock.calls[0][0];

    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });

    expect(preview.points.length).toBe(2);
    expect(preview.points[0]).toEqual({ x: 10, y: 10 });
    expect(preview.points[1]).toEqual({ x: 50, y: 50 });
    expect(mockCanvas.requestRenderAll).toHaveBeenCalled();
  });

  it('should add a new vertex on subsequent pointer down', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 50 });

    const preview = mockCanvas.add.mock.calls[0][0];

    expect(preview.points.length).toBe(3);
    expect(preview.points[0]).toEqual({ x: 10, y: 10 });
    expect(preview.points[1]).toEqual({ x: 50, y: 50 });
    expect(preview.points[2]).toEqual({ x: 50, y: 50 });
  });

  it('should finish open path on double click with fabricObject', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 50 });

    // Double click to finish
    tool.onPointerDown({ type: 'pointerdown', detail: 2 } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;

    expect(params.type).toBe('polyline');
    expect(params.fabricObject).toBeInstanceOf(Polyline);
    // Should be open (not Polygon)
    expect(params.fabricObject).not.toBeInstanceOf(Polygon);

    // Preview should be removed, final object added
    expect(mockCanvas.remove).toHaveBeenCalled();
    // 2 adds: preview + final object
    expect(mockCanvas.add).toHaveBeenCalledTimes(2);
  });

  it('should finish open path on Enter key', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 50 });

    const result = tool.onKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(result).toBe(true);

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;
    expect(params.type).toBe('polyline');
    expect(mockCanvas.remove).toHaveBeenCalled();
  });

  it('should close polygon with C key when >= 3 vertices', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 50 });

    const result = tool.onKeyDown({ key: 'c' } as KeyboardEvent);
    expect(result).toBe(true);

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;
    expect(params.type).toBe('polyline');
    expect(params.fabricObject).toBeInstanceOf(Polygon);
  });

  it('should not close polygon with C key when < 3 vertices, but consume event', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });

    const result = tool.onKeyDown({ key: 'c' } as KeyboardEvent);
    expect(result).toBe(true); // Consumed

    expect(addedParams).toHaveLength(0);
  });

  it('should close polygon when clicking near first point', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 100, y: 100 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 200, y: 100 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 200, y: 200 });

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 102, y: 102 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;
    expect(params.fabricObject).toBeInstanceOf(Polygon);
  });

  it('should cancel path with only one point on Enter', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    const result = tool.onKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(result).toBe(true);

    expect(addedParams).toHaveLength(0);
    expect(mockCanvas.remove).toHaveBeenCalled();
  });

  it('should not create annotation when no active context', () => {
    const noContextCallbacks: ToolCallbacks = {
      ...mockCallbacks,
      getActiveContextId: () => null,
    };

    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, noContextCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerDown({ type: 'pointerdown', detail: 2 } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(0);
  });

  it('should pass through keys when not drawing', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    // Not drawing, so 'c' should return false (not consumed)
    const result = tool.onKeyDown({ key: 'c' } as KeyboardEvent);
    expect(result).toBe(false);

    const resultEsc = tool.onKeyDown({ key: 'Escape' } as KeyboardEvent);
    expect(resultEsc).toBe(false);
  });

  it('should consume keys when drawing', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

    // Drawing, so 'c' should return true (consumed, even if not enough points)
    const result = tool.onKeyDown({ key: 'c' } as KeyboardEvent);
    expect(result).toBe(true);

    const resultEsc = tool.onKeyDown({ key: 'Escape' } as KeyboardEvent);
    expect(resultEsc).toBe(true);
  });
});
