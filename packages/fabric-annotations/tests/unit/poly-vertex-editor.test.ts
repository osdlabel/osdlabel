import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Polygon, Polyline, type FabricObject, type Transform } from 'fabric';
import { PolyVertexEditor } from '../../src/poly-vertex-editor.js';
import { initFabricModule } from '../../src/fabric-module.js';
import type { ToolOverlay } from '../../src/types.js';

initFabricModule();

interface MockCanvas {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  setActiveObject: ReturnType<typeof vi.fn>;
  requestRenderAll: ReturnType<typeof vi.fn>;
  fire: ReturnType<typeof vi.fn>;
}

function makePolygon(id: string): Polygon {
  const poly = new Polygon(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    { id },
  );
  return poly;
}

describe('PolyVertexEditor', () => {
  let canvas: MockCanvas;
  let overlay: ToolOverlay;
  let handlers: Record<string, Array<(...args: unknown[]) => void>>;
  let editor: PolyVertexEditor;

  const fire = (event: string, arg: unknown) => {
    for (const handler of handlers[event] ?? []) handler(arg);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {};
    canvas = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(handler);
      }),
      off: vi.fn(),
      setActiveObject: vi.fn(),
      requestRenderAll: vi.fn(),
      fire: vi.fn(),
    };
    overlay = { canvas } as unknown as ToolOverlay;
    editor = new PolyVertexEditor({ longPressMs: 500, moveTolerancePx: 8 });
    editor.activate(overlay);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const downEvent = (target: FabricObject | undefined, x: number, y: number) => ({
    target,
    viewportPoint: { x, y },
  });

  it('enters edit mode after a long press on a polygon', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    expect(editor.isEditing()).toBe(false);

    vi.advanceTimersByTime(500);

    expect(editor.isEditing()).toBe(true);
    expect(canvas.setActiveObject).toHaveBeenCalledWith(poly);
    // Vertex controls (p0..p3) and edge-insert controls (ins0..ins3) are present.
    expect(Object.keys(poly.controls)).toEqual(
      expect.arrayContaining(['p0', 'p3', 'ins0', 'ins3']),
    );
  });

  it('detaches points from the source array and refreshes hit-test coords on enter', () => {
    // The Fabric object's points come straight from the (immutable) framework
    // store; editing must copy them into a detached array, and must refresh
    // oCoords via setCoords so control hit-testing matches the new control keys.
    const poly = makePolygon('poly-1');
    const sourcePoints = poly.points;
    const setCoordsSpy = vi.spyOn(poly, 'setCoords');

    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);

    expect(poly.points).not.toBe(sourcePoints);
    expect(setCoordsSpy).toHaveBeenCalled();
  });

  it('cancels the long press when the pointer moves beyond tolerance', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    fire('mouse:move', { viewportPoint: { x: 120, y: 100 } });
    vi.advanceTimersByTime(500);
    expect(editor.isEditing()).toBe(false);
  });

  it('ignores read-only objects and objects without an id', () => {
    const readOnly = makePolygon('ro');
    readOnly._readOnly = true;
    fire('mouse:down', downEvent(readOnly, 100, 100));
    vi.advanceTimersByTime(500);
    expect(editor.isEditing()).toBe(false);

    const noId = new Polygon(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      {},
    );
    fire('mouse:down', downEvent(noId, 100, 100));
    vi.advanceTimersByTime(500);
    expect(editor.isEditing()).toBe(false);
  });

  it('does not arm the long press while a draw is in progress', () => {
    const drawingEditor = new PolyVertexEditor({
      longPressMs: 500,
      moveTolerancePx: 8,
      isDrawing: () => true,
    });
    drawingEditor.activate(overlay);
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);
    expect(drawingEditor.isEditing()).toBe(false);
  });

  it('inserts a vertex when an edge handle is pressed', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);

    const before = poly.points.length;
    const transform = { target: poly, corner: 'ins0' } as unknown as Transform;
    poly.controls['ins0']!.mouseDownHandler!(new MouseEvent('mousedown'), transform, 5, 0);

    expect(poly.points.length).toBe(before + 1);
    // The inserted vertex control becomes active for the continuing drag.
    expect(transform.corner).toBe('p1');
  });

  it('deletes the active vertex and commits via object:modified', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);

    poly.__corner = 'p1';
    const before = poly.points.length;
    const consumed = editor.onKeyDown({ key: 'Delete' } as KeyboardEvent);

    expect(consumed).toBe(true);
    expect(poly.points.length).toBe(before - 1);
    expect(canvas.fire).toHaveBeenCalledWith('object:modified', { target: poly });
  });

  it('targets the vertex pressed on mouse:down, even after __corner is cleared', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);

    // User presses the p2 vertex control...
    poly.__corner = 'p2';
    fire('mouse:down', { target: poly, viewportPoint: { x: 10, y: 10 } });
    // ...and Fabric clears __corner on the matching mouse:up.
    poly.__corner = undefined;

    const before = poly.points.length;
    const consumed = editor.onKeyDown({ key: 'Backspace' } as KeyboardEvent);

    expect(consumed).toBe(true);
    expect(poly.points.length).toBe(before - 1);
  });

  it('refuses to delete below the polygon minimum of three points', () => {
    const tri = new Polygon(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 10 },
      ],
      { id: 'tri' },
    );
    fire('mouse:down', downEvent(tri, 100, 100));
    vi.advanceTimersByTime(500);

    tri.__corner = 'p1';
    editor.onKeyDown({ key: 'Delete' } as KeyboardEvent);
    expect(tri.points.length).toBe(3);
  });

  it('exits edit mode on Escape', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);
    expect(editor.isEditing()).toBe(true);

    const consumed = editor.onKeyDown({ key: 'Escape' } as KeyboardEvent);
    expect(consumed).toBe(true);
    expect(editor.isEditing()).toBe(false);
  });

  it('builds one fewer insert handle for an open polyline', () => {
    const line = new Polyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      { id: 'line-1' },
    );
    fire('mouse:down', downEvent(line, 100, 100));
    vi.advanceTimersByTime(500);

    const insertKeys = Object.keys(line.controls).filter((k) => k.startsWith('ins'));
    // 3 points → 2 edges (no closing edge for a polyline).
    expect(insertKeys.length).toBe(2);
  });
});
