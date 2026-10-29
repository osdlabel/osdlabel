import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Canvas, Polygon, Polyline, type FabricObject, type TMat2D, type Transform } from 'fabric';
import { PolyVertexEditor } from '../../src/poly-vertex-editor.js';
import { getGeometryFromFabricObject } from '../../src/fabric-utils.js';
import { initFabricModule } from '../../src/fabric-module.js';
import type { ToolOverlay } from '../../src/types.js';
import { createMockToolOverlay } from './test-helpers.js';

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
    overlay = createMockToolOverlay(canvas);
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

  it('inserts a vertex at the edge midpoint when an edge handle is pressed', () => {
    const poly = makePolygon('poly-1');
    fire('mouse:down', downEvent(poly, 100, 100));
    vi.advanceTimersByTime(500);

    const before = poly.points.length;
    const transform = {
      target: poly,
      corner: 'ins0',
      actionPerformed: false,
    } as unknown as Transform;
    // Pressed off the handle's centre: the vertex still goes to the midpoint.
    poly.controls['ins0']!.mouseDownHandler!(new MouseEvent('mousedown'), transform, 6.5, 2);

    expect(poly.points.length).toBe(before + 1);
    expect({ x: poly.points[1]!.x, y: poly.points[1]!.y }).toEqual({ x: 5, y: 0 });
    // The inserted vertex control becomes active for the continuing drag.
    expect(transform.corner).toBe('p1');
    // The insertion is an edit in its own right, so the release commits it.
    expect(transform.actionPerformed).toBe(true);
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
    delete poly.__corner;

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

// ── Through Fabric's own pointer pipeline ────────────────────────────────────

/**
 * The mock canvas above records what the editor asks of Fabric, but not what
 * Fabric then does with a press and a release: whether the edit reaches the
 * host at all. Here a real canvas, set up as FabricOverlay sets up its own,
 * receives pointer events the way the overlay forwards them, and a commit is
 * exactly what the host stores: the geometry `getGeometryFromFabricObject`
 * reads from the target of an `object:modified`.
 *
 * The invariant: once the pointer is released, the shape Fabric holds (and
 * paints) is the last one committed. Until the fix, a click on an edge-insert
 * handle spliced a vertex into the object, put it at the press point rather
 * than the edge midpoint, and never fired `object:modified`, so the canvas
 * showed one vertex more than state held until the next rebuild dropped it.
 */
describe('PolyVertexEditor through Fabric pointer events', () => {
  interface Pt {
    readonly x: number;
    readonly y: number;
  }

  const canvases: Canvas[] = [];

  beforeEach(() => {
    // Only the long-press timer; Fabric's own scheduling stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      canvases.splice(0).map(async (canvas) => {
        const element = canvas.lowerCanvasEl;
        await canvas.dispose();
        element.remove();
      }),
    );
  });

  // A zoomed, panned view, as the overlay sets for an OSD viewport: control
  // positions and pointer events are in screen px, geometry in image px.
  const VIEW: TMat2D = [2, 0, 0, 2, 30, -40];
  const toScreen = (p: Pt): Pt => ({ x: 2 * p.x + 30, y: 2 * p.y - 40 });

  /**
   * One forwarded pointer event, as FabricOverlay._forwardToFabric sends it:
   * the press on the upper canvas without bubbling, the move and release
   * bubbling (Fabric listens for those on the document). jsdom has no
   * PointerEvent; a MouseEvent carrying the pointer event's type stands in.
   */
  function forward(
    canvas: Canvas,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    at: Pt,
  ): void {
    canvas.upperCanvasEl.dispatchEvent(
      new MouseEvent(type, {
        clientX: at.x,
        clientY: at.y,
        bubbles: type !== 'pointerdown',
        cancelable: true,
        button: 0,
      }),
    );
  }

  /** What the host stores for `obj`: its geometry's points, in image px. */
  function storedPoints(obj: FabricObject): Pt[] {
    const g = getGeometryFromFabricObject(obj, obj instanceof Polygon ? 'polygon' : 'polyline');
    if (!g || (g.type !== 'polygon' && g.type !== 'polyline')) {
      throw new Error(`no poly geometry read from ${obj.type}`);
    }
    return g.points.map(({ x, y }) => ({ x, y }));
  }

  function expectPointsClose(actual: readonly Pt[], expected: readonly Pt[], what: string): void {
    expect(actual.length, `${what}: ${JSON.stringify(actual)}`).toBe(expected.length);
    expected.forEach((e, i) => {
      const a = actual[i]!;
      expect(
        Math.hypot(a.x - e.x, a.y - e.y),
        `${what}: point ${i} is (${a.x}, ${a.y}), expected (${e.x}, ${e.y})`,
      ).toBeLessThan(1e-9);
    });
  }

  /** Where control `key` of `poly` is drawn, in screen px. */
  function control(poly: Polyline, key: string): Pt {
    const coord = poly.oCoords[key];
    expect(coord, `control ${key}`).toBeDefined();
    return { x: coord!.x, y: coord!.y };
  }

  /**
   * A press point on control `key`, off its centre by (3, 4) screen px: inside
   * its 13 px hit box, as a real press is, and far enough off that a vertex
   * put at the press point instead of the midpoint shows.
   */
  function offCentre(poly: Polyline, key: string): Pt {
    const c = control(poly, key);
    return { x: c.x + 3, y: c.y + 4 };
  }

  function click(canvas: Canvas, at: Pt): void {
    forward(canvas, 'pointerdown', at);
    forward(canvas, 'pointerup', at);
  }

  /**
   * `poly` on a canvas, in vertex-edit mode after a long press on `body`
   * (image px), with every commit recorded.
   */
  function openInEditMode(poly: Polyline, body: Pt) {
    const element = document.createElement('canvas');
    document.body.appendChild(element);
    const canvas = new Canvas(element, {
      width: 800,
      height: 600,
      selection: false,
      renderOnAddRemove: false,
      skipOffscreen: false,
      enablePointerEvents: true,
    });
    canvases.push(canvas);
    canvas.setViewportTransform(VIEW);
    canvas.add(poly);
    const editor = new PolyVertexEditor({ longPressMs: 500, moveTolerancePx: 8 });
    editor.activate(createMockToolOverlay(canvas));
    const commits: Pt[][] = [];
    canvas.on('object:modified', ({ target }) => {
      commits.push(storedPoints(target));
    });

    forward(canvas, 'pointerdown', toScreen(body));
    vi.advanceTimersByTime(500);
    forward(canvas, 'pointerup', toScreen(body));
    expect(editor.isEditing(), 'the long press did not enter vertex-edit mode').toBe(true);
    expect(commits, 'entering vertex-edit mode committed something').toEqual([]);
    return { canvas, editor, commits };
  }

  const SQUARE: readonly Pt[] = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 200 },
    { x: 100, y: 200 },
  ];
  const square = () =>
    new Polygon(
      SQUARE.map((p) => ({ ...p })),
      { id: 'square' },
    );

  it('a click on an insert handle commits a vertex at the edge midpoint', () => {
    const poly = square();
    const { canvas, commits } = openInEditMode(poly, { x: 130, y: 170 });

    click(canvas, offCentre(poly, 'ins0'));

    expect(commits, 'the click was never committed').toHaveLength(1);
    const expected = [SQUARE[0]!, { x: 150, y: 100 }, SQUARE[1]!, SQUARE[2]!, SQUARE[3]!];
    expectPointsClose(commits[0]!, expected, 'committed');
    expectPointsClose(storedPoints(poly), expected, 'on the canvas after the release');
  });

  it("a click on a polygon's closing-edge handle inserts after the last vertex", () => {
    const poly = square();
    const { canvas, commits } = openInEditMode(poly, { x: 130, y: 170 });

    click(canvas, offCentre(poly, 'ins3'));

    expect(commits, 'the click was never committed').toHaveLength(1);
    const expected = [...SQUARE, { x: 100, y: 150 }];
    expectPointsClose(commits[0]!, expected, 'committed');
    expectPointsClose(storedPoints(poly), expected, 'on the canvas after the release');
  });

  it('a click on an insert handle of an open polyline commits a vertex at the midpoint', () => {
    const path: readonly Pt[] = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
    ];
    const poly = new Polyline(
      path.map((p) => ({ ...p })),
      { id: 'path', fill: 'transparent' },
    );
    const { canvas, commits } = openInEditMode(poly, { x: 150, y: 150 });

    click(canvas, offCentre(poly, 'ins1'));

    expect(commits, 'the click was never committed').toHaveLength(1);
    const expected = [path[0]!, path[1]!, { x: 200, y: 150 }, path[2]!];
    expectPointsClose(commits[0]!, expected, 'committed');
    expectPointsClose(storedPoints(poly), expected, 'on the canvas after the release');
  });

  it('a press and drag on an insert handle moves the new vertex with the pointer and commits it on release', () => {
    const poly = square();
    const { canvas, commits } = openInEditMode(poly, { x: 130, y: 170 });

    forward(canvas, 'pointerdown', offCentre(poly, 'ins0'));
    forward(canvas, 'pointermove', toScreen({ x: 140, y: 90 }));
    forward(canvas, 'pointermove', toScreen({ x: 155, y: 70 }));
    expect(commits, 'committed before the release').toEqual([]);
    forward(canvas, 'pointerup', toScreen({ x: 155, y: 70 }));

    expect(commits, 'the drag was never committed').toHaveLength(1);
    const expected = [SQUARE[0]!, { x: 155, y: 70 }, SQUARE[1]!, SQUARE[2]!, SQUARE[3]!];
    expectPointsClose(commits[0]!, expected, 'committed');
    expectPointsClose(storedPoints(poly), expected, 'on the canvas after the release');
  });

  it('a click on a vertex handle changes nothing and commits nothing', () => {
    const poly = square();
    const { canvas, commits } = openInEditMode(poly, { x: 130, y: 170 });

    click(canvas, offCentre(poly, 'p1'));

    expect(commits).toEqual([]);
    expectPointsClose(storedPoints(poly), SQUARE, 'on the canvas after the release');
  });

  it('after an insert click, Delete removes the vertex just inserted', () => {
    const poly = square();
    const { canvas, editor, commits } = openInEditMode(poly, { x: 130, y: 170 });

    click(canvas, offCentre(poly, 'ins0'));
    expect(editor.onKeyDown({ key: 'Delete' } as KeyboardEvent)).toBe(true);

    expect(commits, 'expected the insert and the delete to commit').toHaveLength(2);
    expectPointsClose(commits[1]!, SQUARE, 'committed by the delete');
    expectPointsClose(storedPoints(poly), SQUARE, 'on the canvas after the delete');
  });
});
