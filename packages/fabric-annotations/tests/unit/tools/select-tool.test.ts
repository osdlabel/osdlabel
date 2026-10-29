import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { SelectTool } from '../../../src/tools/select-tool.js';
import { RectangleTool } from '../../../src/tools/rectangle-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks } from '../../../src/tools/base-tool.js';
import { buildFabricObjectFromGeometry } from '../../../src/build-fabric-object.js';
import { getFabricOptions } from '../../../src/fabric-utils.js';
import {
  createAnnotationId,
  DEFAULT_ANNOTATION_STYLE,
  type AnnotationId,
  type Geometry,
} from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { ActiveSelection, FabricObject, type Canvas } from 'fabric';
import { createTestKeyboardShortcuts, createMockToolOverlay } from '../test-helpers.js';
import {
  click,
  controlNames,
  controlPoint,
  disposeCanvases,
  gesture,
  openCanvas,
} from '../canvas-harness.js';

describe('SelectTool', () => {
  let tool: SelectTool;
  let mockOverlay: ToolOverlay;
  let mockCanvas: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    discardActiveObject: ReturnType<typeof vi.fn>;
    requestRenderAll: ReturnType<typeof vi.fn>;
    getActiveObject: ReturnType<typeof vi.fn>;
    getActiveObjects: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let mockCallbacks: ToolCallbacks;
  // Fabric supports multiple handlers per event, so capture arrays and fire all
  // (the SelectTool and its PolyVertexEditor both subscribe to some events).
  let capturedHandlers: Record<string, Array<(...args: unknown[]) => void>>;
  const fire = (eventName: string, arg: unknown) => {
    for (const handler of capturedHandlers[eventName] ?? []) handler(arg);
  };
  const imageId = createImageId('test-image-select');
  const contextId = createAnnotationContextId('test-context');
  const mockShortcuts: KeyboardShortcutMap = createTestKeyboardShortcuts();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};

    mockCanvas = {
      on: vi.fn().mockImplementation((eventName: string, handler: (...args: unknown[]) => void) => {
        (capturedHandlers[eventName] ??= []).push(handler);
      }),
      off: vi.fn(),
      discardActiveObject: vi.fn(),
      requestRenderAll: vi.fn(),
      getActiveObject: vi.fn(),
      getActiveObjects: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
    };

    mockOverlay = createMockToolOverlay(mockCanvas);

    mockCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type }),
      canAddAnnotation: () => true,
      addAnnotation: vi.fn(),
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      getAnnotation: vi.fn().mockReturnValue(undefined),
    };

    tool = new SelectTool();
  });

  it('should attach event listeners on activate', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);
    expect(mockCanvas.on).toHaveBeenCalledWith('selection:created', expect.any(Function));
    expect(mockCanvas.on).toHaveBeenCalledWith('selection:cleared', expect.any(Function));
  });

  it('should detach event listeners on deactivate', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);
    tool.deactivate();
    expect(mockCanvas.off).toHaveBeenCalledWith('selection:created', expect.any(Function));
    expect(mockCanvas.off).toHaveBeenCalledWith('selection:cleared', expect.any(Function));
    expect(mockCanvas.discardActiveObject).toHaveBeenCalled();
  });

  it('should trigger setSelectedAnnotation on selection:created with single object', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const annId = createAnnotationId('ann-1');
    const mockObj = { id: annId } as unknown as FabricObject;
    // The tool reads what is selected from the canvas, as Fabric has it by
    // the time it fires the event.
    mockCanvas.getActiveObjects.mockReturnValue([mockObj]);

    fire('selection:created', { selected: [mockObj] });

    expect(mockCallbacks.setSelectedAnnotation).toHaveBeenCalledWith(annId);
  });

  it('should trigger setSelectedAnnotation(null) on selection:created with multiple objects', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const mockObj1 = { id: createAnnotationId('ann-1') } as unknown as FabricObject;
    const mockObj2 = { id: createAnnotationId('ann-2') } as unknown as FabricObject;
    mockCanvas.getActiveObjects.mockReturnValue([mockObj1, mockObj2]);

    fire('selection:created', { selected: [mockObj1, mockObj2] });

    expect(mockCallbacks.setSelectedAnnotation).toHaveBeenCalledWith(null);
  });

  it('should trigger setSelectedAnnotation(null) on selection:cleared', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    fire('selection:cleared', { deselected: [] });

    expect(mockCallbacks.setSelectedAnnotation).toHaveBeenCalledWith(null);
  });

  it('should trigger deleteAnnotation on Delete key', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const annId = createAnnotationId('ann-1');
    const mockObj = { id: annId, type: 'rect' } as unknown as FabricObject;

    mockCanvas.getActiveObjects.mockReturnValue([mockObj]);

    tool.onKeyDown({ key: 'Delete' } as KeyboardEvent);

    expect(mockCallbacks.deleteAnnotation).toHaveBeenCalledWith(annId, imageId);
    expect(mockCanvas.discardActiveObject).toHaveBeenCalled();
  });

  it('should trigger deleteAnnotation on Backspace key', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const annId = createAnnotationId('ann-2');
    const mockObj = { id: annId, type: 'circle' } as unknown as FabricObject;

    mockCanvas.getActiveObjects.mockReturnValue([mockObj]);

    tool.onKeyDown({ key: 'Backspace' } as KeyboardEvent);

    expect(mockCallbacks.deleteAnnotation).toHaveBeenCalledWith(annId, imageId);
  });
});

/**
 * The select tool on a real Fabric canvas, driven through pointer events the
 * way `FabricOverlay` forwards them: what a multi-selection (an
 * `ActiveSelection`) can do. Fabric bakes a selection's transform into each
 * member when it dissolves, so a selection that could be stretched would skew
 * a rotated rectangle and turn a circle into an ellipse, neither of which an
 * annotation's geometry can describe.
 */
describe('SelectTool multi-selection, on a real canvas', () => {
  const imageId = createImageId('img');
  const contextId = createAnnotationContextId('ctx');

  afterEach(disposeCanvases);

  function callbacks(): ToolCallbacks & {
    setSelectedAnnotation: Mock<(id: AnnotationId | null) => void>;
  } {
    return {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type }),
      canAddAnnotation: () => true,
      addAnnotation: vi.fn(),
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn<(id: AnnotationId | null) => void>(),
      getAnnotation: vi.fn().mockReturnValue(undefined),
    };
  }

  function shape(canvas: Canvas, id: string, geometry: Geometry): FabricObject {
    const object = buildFabricObjectFromGeometry(
      geometry,
      getFabricOptions(DEFAULT_ANNOTATION_STYLE, id),
    );
    canvas.add(object);
    return object;
  }

  /** A rectangle turned 30° and a circle, side by side, with the select tool active. */
  function setUp() {
    const canvas = openCanvas();
    const rect = shape(canvas, 'rect', {
      type: 'rectangle',
      origin: { x: 100, y: 100 },
      width: 120,
      height: 60,
      rotation: 30,
    });
    const circle = shape(canvas, 'circle', {
      type: 'circle',
      center: { x: 400, y: 160 },
      radius: 50,
    });
    const tool = new SelectTool();
    const cb = callbacks();
    tool.activate(createMockToolOverlay(canvas), imageId, cb, createTestKeyboardShortcuts());
    return { canvas, rect, circle, tool, cb };
  }

  function activeSelection(canvas: Canvas): ActiveSelection {
    const active = canvas.getActiveObject();
    expect(active, 'a multi-selection is active').toBeInstanceOf(ActiveSelection);
    return active as ActiveSelection;
  }

  it('turns drag-box selection on while active, and off again when deactivated', () => {
    const { canvas, tool } = setUp();
    expect(canvas.selection).toBe(true);
    tool.deactivate();
    expect(canvas.selection).toBe(false);
  });

  it('a drag-box selection has corner and rotation handles only, and cannot skew', () => {
    const { canvas } = setUp();
    // As the overlay used to leave it in annotation mode, so the drag-box runs
    // whatever the tool does with the flag.
    canvas.selection = true;
    gesture(canvas, { x: 20, y: 20 }, { x: 520, y: 300 });

    const selection = activeSelection(canvas);
    expect(
      selection
        .getObjects()
        .map((o) => o.id)
        .sort(),
    ).toEqual(['circle', 'rect']);
    expect(controlNames(selection)).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
    expect(selection.lockSkewingX).toBe(true);
    expect(selection.lockSkewingY).toBe(true);
  });

  it('a corner scales the selection uniformly, even with Shift held', () => {
    const { canvas, rect, circle } = setUp();
    canvas.selection = true;
    gesture(canvas, { x: 20, y: 20 }, { x: 520, y: 300 });
    const selection = activeSelection(canvas);

    // Far more to the right than down, with Shift: a free corner would stretch it.
    const from = controlPoint(selection, 'br');
    gesture(canvas, from, { x: from.x + 120, y: from.y + 10 }, { shiftKey: true });

    expect(selection.scaleX).toBeGreaterThan(1.05);
    expect(selection.scaleY).toBeCloseTo(selection.scaleX, 9);
    expect(selection.skewX).toBe(0);
    expect(selection.skewY).toBe(0);

    // Dissolved, the members carry it as an equal scale and no skew.
    canvas.discardActiveObject();
    expect(rect.scaleY).toBeCloseTo(rect.scaleX, 9);
    expect(rect.skewX).toBeCloseTo(0, 9);
    expect(rect.angle).toBeCloseTo(30, 9);
    expect(circle.scaleY).toBeCloseTo(circle.scaleX, 9);
  });

  it('a Shift+click selection is the same group, and names no single annotation', () => {
    const { canvas, cb } = setUp();
    canvas.selection = true;
    click(canvas, { x: 400, y: 160 });
    expect(canvas.getActiveObject()?.id).toBe('circle');
    expect(cb.setSelectedAnnotation).toHaveBeenLastCalledWith('circle');

    // The rectangle's centre: inside it at any rotation.
    click(canvas, { x: 160, y: 130 }, { shiftKey: true });

    const selection = activeSelection(canvas);
    expect(
      selection
        .getObjects()
        .map((o) => o.id)
        .sort(),
    ).toEqual(['circle', 'rect']);
    expect(controlNames(selection)).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
    // Fabric reports only the newly added member on `selection:updated`; two
    // annotations are selected, so neither is "the" selected one.
    expect(cb.setSelectedAnnotation).toHaveBeenLastCalledWith(null);
  });

  it('once deactivated, a drawing drag across shapes selects none of them', () => {
    const { canvas, tool } = setUp();
    // Whoever turned the drag-box on, the select tool turns it off on its way out.
    canvas.selection = true;
    tool.deactivate();
    const rectangleTool = new RectangleTool();
    rectangleTool.activate(
      createMockToolOverlay(canvas),
      imageId,
      callbacks(),
      createTestKeyboardShortcuts(),
    );

    gesture(canvas, { x: 20, y: 20 }, { x: 520, y: 300 });

    expect(canvas.getActiveObject()).toBeUndefined();
    rectangleTool.deactivate();
  });
});
