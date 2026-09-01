import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolylineTool } from '../../../src/tools/polyline-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../../src/tools/base-tool.js';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { Polyline, Polygon, Circle } from 'fabric';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

describe('PolylineTool', () => {
  let tool: PolylineTool;
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

  describe('preview style (issue #156)', () => {
    it("draws the preview in the tool constraint's defaultStyle", () => {
      mockCallbacks = {
        ...mockCallbacks,
        getToolConstraint: (type) => ({
          type,
          defaultStyle: { strokeColor: '#00e5ff', strokeWidth: 3 },
        }),
      };
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      const preview = mockCanvas.add.mock.calls[0][0];
      expect(preview.stroke).toBe('#00e5ff');
      expect(preview.strokeWidth).toBe(3);
    });

    it('keeps the preview dashed, non-interactive, id-less and read-only', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      const preview = mockCanvas.add.mock.calls[0][0];
      expect(preview.strokeDashArray).toEqual([5, 5]);
      expect(preview.selectable).toBe(false);
      expect(preview.evented).toBe(false);
      // `id` is reserved for annotation objects; previews must not carry one.
      expect(preview.id).toBeUndefined();
      expect(preview._readOnly).toBe(true);
    });

    it('honours an explicit strokeDashArray from the style', () => {
      mockCallbacks = {
        ...mockCallbacks,
        getToolConstraint: (type) => ({ type, defaultStyle: { strokeDashArray: [2, 8] } }),
      };
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      expect(mockCanvas.add.mock.calls[0][0].strokeDashArray).toEqual([2, 8]);
    });

    it('commits the annotation in the same style as the preview', () => {
      mockCallbacks = {
        ...mockCallbacks,
        getToolConstraint: (type) => ({ type, defaultStyle: { strokeColor: '#00e5ff' } }),
      };
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      const preview = mockCanvas.add.mock.calls[0][0];
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });
      tool.onKeyDown({ key: 'Enter' } as KeyboardEvent);

      expect(addedParams[0]!.fabricObject.stroke).toBe(preview.stroke);
    });
  });

  describe('vertex markers (issue #156)', () => {
    const markersOf = (calls: unknown[][]): Circle[] =>
      calls.map((call) => call[0]).filter((obj): obj is Circle => obj instanceof Circle);

    it('draws one marker per committed vertex', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      expect(markersOf(mockCanvas.add.mock.calls)).toHaveLength(1);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });
      const markers = markersOf(mockCanvas.add.mock.calls);
      expect(markers).toHaveLength(2);
      expect(markers[1]!.left).toBe(50);
      expect(markers[1]!.top).toBe(10);
    });

    it('marks vertices as inert chrome, not annotations', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      const marker = markersOf(mockCanvas.add.mock.calls)[0]!;
      expect(marker.id).toBeUndefined();
      expect(marker._readOnly).toBe(true);
      expect(marker.selectable).toBe(false);
      expect(marker.evented).toBe(false);
    });

    it('draws the first vertex larger than the rest, as the close target', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });

      const [first, second] = markersOf(mockCanvas.add.mock.calls);
      expect(first!.radius).toBeGreaterThan(second!.radius);
      // Hollow until closing is possible.
      expect(first!.fill).toBe('transparent');
    });

    it('sizes markers in screen pixels, independent of zoom', () => {
      mockCanvas.getZoom.mockReturnValue(4);
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      // 5 screen px at zoom 4 → 1.25 image px.
      expect(markersOf(mockCanvas.add.mock.calls)[0]!.radius).toBeCloseTo(1.25);
    });

    it('fills the first vertex once a click there would close the shape', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 100, y: 100 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 200, y: 100 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 200, y: 200 });

      const first = markersOf(mockCanvas.add.mock.calls)[0]!;
      expect(first.fill).toBe('transparent');

      tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 102, y: 102 });
      expect(first.fill).not.toBe('transparent');

      tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 400, y: 400 });
      expect(first.fill).toBe('transparent');
    });

    it('removes markers when the path is cancelled', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });
      const markers = markersOf(mockCanvas.add.mock.calls);

      tool.cancel();

      const removed = mockCanvas.remove.mock.calls.map((call) => call[0]);
      for (const marker of markers) expect(removed).toContain(marker);
    });

    it('removes markers when the path is committed', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });
      const markers = markersOf(mockCanvas.add.mock.calls);

      tool.onKeyDown({ key: 'Enter' } as KeyboardEvent);

      const removed = mockCanvas.remove.mock.calls.map((call) => call[0]);
      for (const marker of markers) expect(removed).toContain(marker);
    });

    it('draws no markers when they are disabled', () => {
      tool = new PolylineTool({ longPressMs: 500, moveTolerancePx: 8 }, { enabled: false });
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });

      expect(markersOf(mockCanvas.add.mock.calls)).toHaveLength(0);
    });
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
    // preview + one vertex marker per committed vertex + the final object
    const added = mockCanvas.add.mock.calls.map((call) => call[0]);
    expect(added).toHaveLength(4);
    expect(added[added.length - 1]).toBe(params.fabricObject);
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
