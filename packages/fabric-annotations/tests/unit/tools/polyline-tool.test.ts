import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolylineTool } from '../../../src/tools/polyline-tool.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../../src/tools/base-tool.js';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { Polyline, Polygon, Circle } from 'fabric';
import {
  createTestKeyboardShortcuts,
  createMockCanvas,
  expectFabricInstance,
  type MockFabricCanvas,
  createMockToolOverlay,
  type MockToolOverlay,
} from '../test-helpers.js';

describe('PolylineTool', () => {
  let tool: PolylineTool;
  let mockOverlay: MockToolOverlay;
  let mockCanvas: MockFabricCanvas;
  let mockCallbacks: ToolCallbacks;
  let addedParams: AddAnnotationParams[];
  const imageId = createImageId('test-image');
  const contextId = createAnnotationContextId('test-context');
  const mockShortcuts: KeyboardShortcutMap = createTestKeyboardShortcuts();

  beforeEach(() => {
    vi.clearAllMocks();
    addedParams = [];

    mockCanvas = createMockCanvas();

    mockOverlay = createMockToolOverlay(mockCanvas);

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

      expect(mockCanvas.add).toHaveBeenCalled();
      const preview = mockCanvas.add.mock.calls[0]![0];
      expect(preview.stroke).toBe('#00e5ff');
      expect(preview.strokeWidth).toBe(3);
    });

    it('keeps the preview dashed, non-interactive, id-less and read-only', () => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      expect(mockCanvas.add).toHaveBeenCalled();
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

      expect(mockCanvas.add).toHaveBeenCalled();
      expect(mockCanvas.add.mock.calls[0]![0].strokeDashArray).toEqual([2, 8]);
    });

    it('scales the preview stroke to screen pixels', () => {
      mockCanvas.getZoom.mockReturnValue(0.1);
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

      tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

      // DEFAULT_ANNOTATION_STYLE.strokeWidth (2) at zoom 0.1 must still land as
      // 2 screen px, not a 0.2 px hairline.
      expect(mockCanvas.add).toHaveBeenCalled();
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
      expect(mockCanvas.add).toHaveBeenCalled();
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
    const addedObj = expectFabricInstance(mockCanvas.add.mock.calls[0]![0], Polyline);
    expect(addedObj.points.length).toBe(2);
    expect(addedObj.points[0]).toEqual({ x: 10, y: 10 });
    expect(addedObj.points[1]).toEqual({ x: 10, y: 10 });
  });

  it('should update the cursor point on pointer move', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

    expect(mockCanvas.add).toHaveBeenCalled();
    const preview = expectFabricInstance(mockCanvas.add.mock.calls[0]![0], Polyline);

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

    expect(mockCanvas.add).toHaveBeenCalled();
    const preview = expectFabricInstance(mockCanvas.add.mock.calls[0]![0], Polyline);

    expect(preview.points.length).toBe(3);
    expect(preview.points[0]).toEqual({ x: 10, y: 10 });
    expect(preview.points[1]).toEqual({ x: 50, y: 50 });
    expect(preview.points[2]).toEqual({ x: 50, y: 50 });
  });

  it('should finish open path on double click with fabricObject', () => {
    tool = new PolylineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const stamped = (): PointerEvent => {
      const event = { type: 'pointerdown' } as PointerEvent;
      mockOverlay.stampPress(event);
      return event;
    };

    tool.onPointerDown(stamped(), { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    const first = stamped();
    tool.onPointerDown(first, { x: 50, y: 50 });

    // A double click delivers both of its pointerdowns before the overlay
    // reports the gesture, so the second vertex at (50, 50) is the artefact
    // onDoubleClick drops. Driving it in that order is the point: asserting
    // against a hand-built `{ detail: 2 }` event is what hid #168, since no
    // pointerdown the browser delivers here ever carries a non-zero `detail`.
    const second = stamped();
    tool.onPointerDown(second, { x: 50, y: 50 });
    tool.onDoubleClick!({ type: 'pointerup' } as PointerEvent, { x: 50, y: 50 }, [
      mockOverlay.seqOf(first)!,
      mockOverlay.seqOf(second)!,
    ]);

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;

    expect(params.type).toBe('polyline');
    expect(params.fabricObject).toBeInstanceOf(Polyline);
    // Two vertices, not three: the duplicate the gesture's second press added
    // is gone. Without this the test passed either way, and the committed path
    // quietly gained a degenerate repeated vertex.
    expect((params.fabricObject as Polyline).points).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 50 },
    ]);
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

  /**
   * Vertex attribution for a double click (#176).
   *
   * A double click delivers both of its presses before the callback, so the
   * path may have gained two vertices, one, or none — a press landing on an
   * existing annotation is suppressed by the framework hooks and never reaches
   * the tool. The tool identifies its own vertices by the press that placed
   * each one, so every case below is the same rule rather than a geometric
   * special case: drop a tail vertex iff its press is one of the pair.
   *
   * `press()` returns a fresh event object per call, which is what makes the
   * mock overlay hand out distinct sequences — the same thing `_recordPress`
   * does for real presses.
   */
  describe('drops exactly the vertices its own presses added', () => {
    /** A press the overlay forwarded, so it carries a sequence — as in production. */
    const press = (): PointerEvent => {
      const event = { type: 'pointerdown' } as PointerEvent;
      mockOverlay.stampPress(event);
      return event;
    };
    const release = (): PointerEvent => ({ type: 'pointerup' }) as PointerEvent;
    /** The sequence of a press the tool never saw, because it was suppressed. */
    const SUPPRESSED = 9999;
    const seq = (event: PointerEvent): number => {
      const value = mockOverlay.seqOf(event);
      expect(value).toBeDefined();
      return value!;
    };

    beforeEach(() => {
      tool = new PolylineTool();
      tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);
    });

    it("drops the second press's duplicate, ending the path at the clicked point", () => {
      const a = press();
      const b = press();
      const c = press();
      const d = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 90, y: 10 });
      tool.onPointerDown(c, { x: 90, y: 70 });
      tool.onPointerDown(d, { x: 91, y: 71 });
      tool.onDoubleClick!(release(), { x: 91, y: 71 }, [seq(c), seq(d)]);

      expect(addedParams).toHaveLength(1);
      // Four, not five: the near-duplicate at (91,71) is gone and the vertex
      // the gesture's *first* press placed is the endpoint the user asked for.
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 70 },
      ]);
    });

    it('keeps the lone vertex when only the first press was suppressed', () => {
      const a = press();
      const b = press();
      const c = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 90, y: 10 });
      // The gesture's first press landed on an annotation; only its second
      // reached the tool, so exactly one vertex is this gesture's.
      tool.onPointerDown(c, { x: 91, y: 11 });
      tool.onDoubleClick!(release(), { x: 91, y: 11 }, [SUPPRESSED, seq(c)]);

      expect(addedParams).toHaveLength(1);
      // The gesture contributed one vertex, so it is the endpoint, not an
      // artefact. Dropping it would discard a click the user made.
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 91, y: 11 },
      ]);
    });

    it('keeps the lone vertex when only the second press was suppressed', () => {
      const a = press();
      const b = press();
      const c = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 90, y: 10 });
      tool.onPointerDown(c, { x: 90, y: 70 });
      tool.onDoubleClick!(release(), { x: 90, y: 70 }, [seq(c), SUPPRESSED]);

      expect(addedParams).toHaveLength(1);
      // No vertex carries the second press's sequence, so there is no
      // duplicate to remove.
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 70 },
      ]);
    });

    it('keeps every vertex when both presses were suppressed', () => {
      const a = press();
      const b = press();
      const c = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 90, y: 10 });
      tool.onPointerDown(c, { x: 90, y: 70 });
      tool.onDoubleClick!(release(), { x: 90, y: 70 }, [SUPPRESSED, SUPPRESSED + 1]);

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 70 },
      ]);
    });

    it('does not discard a short path when only one press reached the tool', () => {
      const a = press();
      const b = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      // The gesture's first press landed on an annotation and was suppressed;
      // its second placed this vertex. Two vertices total, and popping either
      // would take the path under `finish`'s minimum.
      tool.onPointerDown(b, { x: 90, y: 10 });
      tool.onDoubleClick!(release(), { x: 90, y: 10 }, [SUPPRESSED, seq(b)]);

      // Popping either vertex would leave one, and `finish` would cancel —
      // losing the user's whole in-progress path rather than committing it.
      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
      ]);
    });

    it('commits nothing when a double click lands on an idle canvas', () => {
      const a = press();
      const b = press();
      // The overlay reports the gesture only after forwarding both presses, so
      // the tool always has two near-coincident vertices here. The duplicate is
      // dropped, leaving one — below `finish`'s two-point minimum, so the path
      // is cancelled rather than committed as a 1px polyline.
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 11, y: 11 });
      tool.onDoubleClick!(release(), { x: 11, y: 11 }, [seq(a), seq(b)]);

      expect(addedParams).toHaveLength(0);
    });

    it('never pops when the presses are not ones the overlay forwarded', () => {
      const a = press();
      const b = press();
      const c = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 90, y: 10 });
      tool.onPointerDown(c, { x: 90, y: 70 });
      // No pair supplied at all — the shape every hand-built test event has,
      // and the shape a future caller that forgets to pass it would have.
      tool.onDoubleClick!(release(), { x: 90, y: 70 });

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 70 },
      ]);
    });

    it('requires the tail itself to be the second press, not merely to follow it', () => {
      const a = press();
      const b = press();
      const c = press();
      tool.onPointerDown(a, { x: 10, y: 10 });
      tool.onPointerDown(b, { x: 90, y: 10 });
      tool.onPointerDown(c, { x: 90, y: 70 });
      // `b` is named as the gesture's first press while `c` — a later, ordinary
      // vertex — sits on the tail. A real stream cannot produce this, since the
      // gesture reports immediately after its own two presses; the check exists
      // so that a future change which *can* produce it does not silently delete
      // a user's vertex. This pins the *tail* half of the match; the
      // predecessor half is pinned by the suppressed-press tests above.
      tool.onDoubleClick!(release(), { x: 90, y: 70 }, [seq(b), SUPPRESSED]);

      expect(addedParams).toHaveLength(1);
      expect((addedParams[0]!.fabricObject as Polyline).points).toEqual([
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 70 },
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
