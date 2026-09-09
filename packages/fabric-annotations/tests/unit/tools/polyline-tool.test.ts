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

      const preview = mockCanvas.add.mock.calls[0]![0];
      expect(preview.stroke).toBe('#00e5ff');
      expect(preview.strokeWidth).toBe(3);
    });

    it('keeps the preview dashed, non-interactive, id-less and read-only', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      const preview = mockCanvas.add.mock.calls[0]![0];
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

      expect(mockCanvas.add.mock.calls[0]![0].strokeDashArray).toEqual([2, 8]);
    });

    it('scales the preview stroke to screen pixels', () => {
      mockCanvas.getZoom.mockReturnValue(0.1);
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      // DEFAULT_ANNOTATION_STYLE.strokeWidth (2) at zoom 0.1 must still land as
      // 2 screen px, not a 0.2 px hairline.
      expect(mockCanvas.add.mock.calls[0]![0].strokeWidth).toBeCloseTo(20);
    });

    it('styles the commit by the context active at finish, not at draw start', () => {
      let activeStyle = { strokeColor: '#ff0000' };
      mockCallbacks = {
        ...mockCallbacks,
        getToolConstraint: (type) => ({ type, defaultStyle: activeStyle }),
      };
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 10 });

      // The user switches annotation context mid-draw; finish() reads the
      // context id live, so the style must follow it.
      activeStyle = { strokeColor: '#0000ff' };
      tool.onKeyDown({ key: 'Enter' } as KeyboardEvent);

      expect(addedParams[0]!.fabricObject.stroke).toBe('#0000ff');
    });

    it('commits the annotation in the same style as the preview', () => {
      mockCallbacks = {
        ...mockCallbacks,
        getToolConstraint: (type) => ({ type, defaultStyle: { strokeColor: '#00e5ff' } }),
      };
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      const preview = mockCanvas.add.mock.calls[0]![0];
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
    const addedObj = mockCanvas.add.mock.calls[0]![0];
    expect(addedObj).toBeInstanceOf(Polyline);
    expect(addedObj.points.length).toBe(2);
    expect(addedObj.points[0]).toEqual({ x: 10, y: 10 });
    expect(addedObj.points[1]).toEqual({ x: 10, y: 10 });
  });

  it('should update the cursor point on pointer move', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

    const preview = mockCanvas.add.mock.calls[0]![0];

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

    const preview = mockCanvas.add.mock.calls[0]![0];

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

    // A double click delivers both of its pointerdowns before the overlay
    // reports the gesture, so the second vertex at (50, 50) is the artefact
    // onDoubleClick drops. Driving it in that order is the point: asserting
    // against a hand-built `{ detail: 2 }` event is what hid #168, since no
    // pointerdown the browser delivers here ever carries a non-zero `detail`.
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 50, y: 50 });
    tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;

    expect(params.type).toBe('polyline');
    expect(params.fabricObject).toBeInstanceOf(Polyline);
    // Should be open (not Polygon)
    expect(params.fabricObject).not.toBeInstanceOf(Polygon);

    // Preview should be removed, final object added
    expect(mockCanvas.remove).toHaveBeenCalled();
    // preview + one vertex marker per press (three, including the double
    // click's own second press) + the final object. The marker for the vertex
    // `onDoubleClick` drops was still added while drawing, so it is counted
    // here; `mockCanvas.remove` above is what clears the drawing chrome.
    const added = mockCanvas.add.mock.calls.map((call) => call[0]);
    expect(added).toHaveLength(5);
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
    tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(0);
  });

  it("drops the duplicate vertex the double click's own second press added", () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    // Three deliberate vertices, then a double click at a fourth position:
    // press, press (the artefact), then the gesture report.
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 70 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 40, y: 70 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 41, y: 71 });
    tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 41, y: 71 });

    expect(addedParams).toHaveLength(1);
    // Four vertices, not five: the near-duplicate at (41, 71) is gone and the
    // user's own fourth click at (40, 70) is the final one.
    expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 70 },
      { x: 40, y: 70 },
    ]);
  });

  it('commits the shortest open polyline: one click, then a double click', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    // One deliberate vertex, then a double click elsewhere — three presses in
    // total, one of which the gesture drops. Two vertices survive, which is
    // exactly `finish`'s minimum for an open path.
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 91, y: 11 });
    tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 91, y: 11 });

    expect(addedParams).toHaveLength(1);
    expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
    ]);
  });

  it('commits nothing when a double click lands on an idle canvas', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    // The real stream, which is the whole point: the overlay reports the
    // gesture only *after* forwarding both of its presses, so the tool always
    // has two vertices here — near-coincident, since the two clicks are within
    // the double-click distance threshold. Calling `onDoubleClick` with no
    // preceding press is a sequence the overlay cannot produce, and asserting
    // against it is what let this commit a degenerate 1px polyline.
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 11, y: 11 });
    tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 11, y: 11 });

    expect(addedParams).toHaveLength(0);
  });

  /**
   * A press that lands on an existing annotation is suppressed by the framework
   * hooks and never reaches the tool, so a double click can arrive having
   * contributed one vertex or none. Popping on a count rather than on geometry
   * discards a vertex the user placed — and on a short path that drops it under
   * `finish`'s minimum, throwing the whole path away.
   */
  describe("when the gesture's presses were suppressed", () => {
    it('keeps every vertex when neither press reached the tool', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 70 });
      // Both presses landed on an annotation: no vertex was added for either.
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 90, y: 70 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 70 },
      ]);
    });

    it('does not discard a short path when only one press reached the tool', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      // First press suppressed, second not: one vertex, far from the previous.
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 10 });
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 90, y: 10 });

      // Popping here would leave one vertex, and `finish` would cancel — losing
      // the user's whole in-progress path rather than committing it.
      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
      ]);
    });
  });

  /**
   * The two bounds are different sizes on purpose, and the gap between them is
   * where the interesting cases live: 5px for the second press (which is
   * pinned to its own release) and 25px for the first (which is three hops
   * away). A vertex in that band came from the first press, not the second.
   */
  describe('distinguishes the two presses by their different bounds', () => {
    it('keeps the finish vertex when only the first press reached the tool', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      // Second press suppressed. The first press's vertex is 15px from the
      // release — beyond the second-press bound but inside the first's — so it
      // is the point the user finished on and must survive.
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 0, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 80, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 85, y: 0 });
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 100, y: 0 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 85, y: 0 },
      ]);
    });

    it('drops the duplicate at a drift only the composed bound allows', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      // 22px from the release: inside the first press's bound only because it
      // composes `clickDistThreshold` (5) with `dblClickDistThreshold` (20).
      // Reading the 20 alone — the bound the fix was written to correct — would
      // reject this and leave the duplicate behind.
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 33, y: 70 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 55, y: 70 });
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 55, y: 70 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 33, y: 70 },
      ]);
    });

    it('still drops the duplicate when the two presses drifted apart', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      // A jittery double click: the presses are 15px apart, well beyond what a
      // naive "the last two vertices are basically the same point" test would
      // accept, but both are inside their respective bounds.
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 90, y: 10 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 40, y: 70 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 55, y: 70 });
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 55, y: 70 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 40, y: 70 },
      ]);
    });
  });

  /**
   * The thresholds are properties of the input device, so they are measured in
   * screen space and must not scale with zoom. With the identity
   * `imageToScreen` the rest of this file uses, comparing raw image
   * coordinates instead would pass every other test — these two put a scale on
   * the stub so the two spaces disagree.
   */
  describe('measures its thresholds in screen space', () => {
    function scaleOverlay(factor: number): ToolOverlay {
      return {
        canvas: mockCanvas,
        imageToScreen: vi.fn((p: { x: number; y: number }) => ({
          x: p.x * factor,
          y: p.y * factor,
        })),
      } as unknown as ToolOverlay;
    }

    it('drops the duplicate when zoomed out far enough to bring the pair together', () => {
      tool = new PolylineTool();
      tool.activate(scaleOverlay(0.1), imageId, mockCallbacks, mockShortcuts);

      // The gesture's two presses are 30 *image* px apart — beyond the 25px
      // first-press bound if that bound were read as image space, but only 3px
      // apart on screen at this zoom.
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 0, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 1000, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 2000, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 2030, y: 0 });
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 2030, y: 0 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 2000, y: 0 },
      ]);
    });

    it('keeps two deliberate vertices that are close in image space but not on screen', () => {
      tool = new PolylineTool();
      tool.activate(scaleOverlay(10), imageId, mockCallbacks, mockShortcuts);

      // 3 image px apart — inside every threshold read as image space, but 30px
      // apart on screen, so the pair is not this gesture's.
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 0, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 100, y: 0 });
      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 103, y: 0 });
      tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 103, y: 0 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 103, y: 0 },
      ]);
    });
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
