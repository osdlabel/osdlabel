/**
 * The minimum size for paths: when `PolylineTool` or `FreeHandPathTool`
 * finishes a path whose vertices all lie within `MIN_SHAPE_SCREEN_PX` of one
 * another on screen, it discards the path, preview and markers included,
 * instead of committing it, and is ready for a new one. The same 3 px as a
 * drag-to-draw shape (`shape-tool.test.ts`), measured the same way, through the
 * overlay's `imageToScreen`.
 *
 * Before it, a click followed by a double click at one spot, or two clicks
 * there and Enter, committed an invisible zero-length polyline, and three
 * clicks there and 'c' (or a fourth click, on the first vertex) a zero-area
 * polygon. Each counted toward the context's `maxCount`.
 *
 * Sizes are chosen on screen and converted to image px through the view, so
 * the same case reads the same at every zoom; the views include a rotated and
 * mirrored one.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { Circle, Polygon, Polyline, type FabricObject } from 'fabric';
import type { Point } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { MIN_SHAPE_SCREEN_PX } from '../../../src/tools/shape-tool.js';
import { PolylineTool } from '../../../src/tools/polyline-tool.js';
import { FreeHandPathTool } from '../../../src/tools/free-hand-path-tool.js';
import type { AddAnnotationParams, ToolCallbacks } from '../../../src/tools/base-tool.js';
import {
  createMockCanvas,
  createMockToolOverlay,
  createTestKeyboardShortcuts,
  expectFabricInstance,
  type MockFabricCanvas,
  type MockToolOverlay,
} from '../test-helpers.js';

const imageId = createImageId('test-image');
const contextId = createAnnotationContextId('test-context');

/** A view: how image px map to screen px, and its scale (screen px per image px). */
interface View {
  readonly name: string;
  readonly zoom: number;
  readonly toScreen: (p: Point) => Point;
}

function view(name: string, zoom: number, degrees: number, mirrored: boolean): View {
  const t = (degrees * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return {
    name,
    zoom,
    toScreen: (p) => {
      const x = zoom * (p.x * cos - p.y * sin);
      const y = zoom * (p.x * sin + p.y * cos);
      // A translation, as the real view has, so a measurement that reads
      // positions instead of distances is caught.
      return { x: (mirrored ? 900 - x : x) + 37, y: y - 11 };
    },
  };
}

const ZOOMED_OUT = view('zoomed out, 0.25 screen px per image px', 0.25, 0, false);
const ZOOMED_IN = view('zoomed in, 4 screen px per image px', 4, 0, false);
const VIEWS: readonly View[] = [
  ZOOMED_OUT,
  ZOOMED_IN,
  view('rotated 30° and mirrored, at 2 screen px per image px', 2, 30, true),
];

/** An image-space point to start every path from. */
const START: Point = { x: 400, y: 300 };

/** `from` plus a screen-space offset, in image space (the view's linear part, inverted). */
function offsetOnScreen(v: View, from: Point, screen: Point): Point {
  const o = v.toScreen({ x: 0, y: 0 });
  const ex = v.toScreen({ x: 1, y: 0 });
  const ey = v.toScreen({ x: 0, y: 1 });
  const a = ex.x - o.x;
  const b = ex.y - o.y;
  const c = ey.x - o.x;
  const d = ey.y - o.y;
  const det = a * d - b * c;
  return {
    x: from.x + (d * screen.x - c * screen.y) / det,
    y: from.y + (-b * screen.x + a * screen.y) / det,
  };
}

/** Two vertices `size` screen px apart, diagonally on screen. */
function segment(v: View, size: number): readonly Point[] {
  return [START, offsetOnScreen(v, START, { x: size * 0.6, y: -size * 0.8 })];
}

/** Three vertices `size` screen px apart from one another: an equilateral triangle on screen. */
function triangle(v: View, size: number): readonly Point[] {
  return [
    START,
    offsetOnScreen(v, START, { x: size, y: 0 }),
    offsetOnScreen(v, START, { x: size / 2, y: (size * Math.sqrt(3)) / 2 }),
  ];
}

interface Harness {
  readonly canvas: MockFabricCanvas;
  readonly overlay: MockToolOverlay;
  readonly addAnnotation: Mock<(params: AddAnnotationParams) => void>;
}

/**
 * Activate `tool` in a view. `toScreen` is read on every call, so a test can
 * change the view part-way through a path by passing a function that does.
 */
function setUp(tool: PolylineTool | FreeHandPathTool, toScreen: (p: Point) => Point): Harness {
  const canvas = createMockCanvas();
  const overlay = createMockToolOverlay(canvas, toScreen);
  const addAnnotation = vi.fn<(params: AddAnnotationParams) => void>();
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: (type) => ({ type }),
    canAddAnnotation: () => true,
    addAnnotation,
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    getAnnotation: vi.fn().mockReturnValue(undefined),
  };
  tool.activate(overlay, imageId, callbacks, createTestKeyboardShortcuts());
  return { canvas, overlay, addAnnotation };
}

/** A click at `p`: a press the overlay forwarded (so it carries a sequence), then its release. */
function click(h: Harness, tool: PolylineTool, p: Point): number {
  const event = { type: 'pointerdown' } as PointerEvent;
  const seq = h.overlay.stampPress(event);
  tool.onPointerDown(event, p);
  tool.onPointerUp({ type: 'pointerup' } as PointerEvent, p);
  return seq;
}

function key(tool: PolylineTool, k: string): void {
  expect(tool.onKeyDown({ key: k } as KeyboardEvent), `${k} is consumed`).toBe(true);
}

/** A way to finish a path, and what it commits. */
interface Finish {
  readonly name: string;
  readonly closed: boolean;
  /** Click each of `points` in turn and finish the path, ending it at the last one. */
  readonly draw: (h: Harness, tool: PolylineTool, points: readonly Point[]) => void;
}

/** Enter ends the path open: the finish the cases below that need just one use. */
const BY_ENTER: Finish = {
  name: 'Enter',
  closed: false,
  draw: (h, tool, points) => {
    for (const p of points) click(h, tool, p);
    key(tool, 'Enter');
  },
};

const FINISHES: readonly Finish[] = [
  {
    name: 'a double click on the last vertex',
    closed: false,
    draw: (h, tool, points) => {
      for (const p of points.slice(0, -1)) click(h, tool, p);
      // The gesture's two presses both reach the tool before the overlay
      // reports it; the second's vertex is the one the tool drops.
      const last = points[points.length - 1]!;
      const first = click(h, tool, last);
      const second = click(h, tool, last);
      tool.onDoubleClick({ type: 'pointerup' } as PointerEvent, last, [first, second]);
    },
  },
  BY_ENTER,
  {
    name: "'c'",
    closed: true,
    draw: (h, tool, points) => {
      for (const p of points) click(h, tool, p);
      key(tool, 'c');
    },
  },
  {
    name: 'a click on the first vertex',
    closed: true,
    draw: (h, tool, points) => {
      for (const p of points) click(h, tool, p);
      click(h, tool, points[0]!);
    },
  },
];

/** The path each finish draws at `size` screen px: a segment if it ends open, a triangle if closed. */
function pathFor(f: Finish, v: View, size: number): readonly Point[] {
  return f.closed ? triangle(v, size) : segment(v, size);
}

/** The preview: the first object the tool put on the canvas. */
function previewOf(h: Harness): Polyline {
  expect(h.canvas.add).toHaveBeenCalled();
  return expectFabricInstance(h.canvas.add.mock.calls[0]![0], Polyline);
}

/** Nothing committed, and nothing the path put on the canvas is left there. */
function expectDiscarded(h: Harness): void {
  const preview = previewOf(h);
  expect(h.addAnnotation).not.toHaveBeenCalled();
  const added = h.canvas.add.mock.calls.map((call) => call[0]);
  // No annotation object was built either: everything added is the preview
  // or a vertex marker, none of which carries an id.
  expect(added.filter((o) => o.id !== undefined)).toEqual([]);
  // The preview and every marker are taken off again.
  const removed = new Set(h.canvas.remove.mock.calls.map((call) => call[0]));
  expect(removed.has(preview), 'the preview is removed').toBe(true);
  const markers = added.filter((o) => o instanceof Circle);
  expect(markers.length, 'markers were drawn while drawing').toBeGreaterThan(0);
  for (const marker of markers) expect(removed.has(marker), 'a marker is removed').toBe(true);
  // The removal is painted, not left for some later render to pick up.
  const removedAt = Math.max(...h.canvas.remove.mock.invocationCallOrder);
  expect(
    h.canvas.requestRenderAll.mock.invocationCallOrder.some((order) => order > removedAt),
  ).toBe(true);
}

function expectCommitted(h: Harness, closed: boolean, points: readonly Point[]): void {
  expect(h.addAnnotation).toHaveBeenCalledTimes(1);
  const params = h.addAnnotation.mock.calls[0]![0];
  expect(params.type).toBe('polyline');
  const object: FabricObject = params.fabricObject;
  const shape = closed
    ? expectFabricInstance(object, Polygon)
    : expectFabricInstance(object, Polyline);
  expect(shape.points).toEqual(points.map((p) => ({ x: p.x, y: p.y })));
}

describe('PolylineTool: a path smaller than MIN_SHAPE_SCREEN_PX on screen is discarded', () => {
  for (const v of VIEWS) {
    describe(v.name, () => {
      for (const f of FINISHES) {
        it(`${f.name}: every vertex at one spot commits nothing`, () => {
          const tool = new PolylineTool();
          const h = setUp(tool, v.toScreen);
          f.draw(h, tool, f.closed ? [START, START, START] : [START, START]);
          expectDiscarded(h);
        });

        it(`${f.name}: a path 2.9 screen px across is discarded`, () => {
          const tool = new PolylineTool();
          const h = setUp(tool, v.toScreen);
          f.draw(h, tool, pathFor(f, v, 2.9));
          expectDiscarded(h);
        });

        it(`${f.name}: a path 3.1 screen px across is committed`, () => {
          const tool = new PolylineTool();
          const h = setUp(tool, v.toScreen);
          const points = pathFor(f, v, 3.1);
          f.draw(h, tool, points);
          expectCommitted(h, f.closed, points);
        });
      }
    });
  }

  it('the minimum is inclusive: a path exactly 3 screen px across is committed', () => {
    // Zoom 2 and 1.5 image px make the measurement exactly 3.
    const v = view('zoom 2', 2, 0, false);
    const tool = new PolylineTool();
    const h = setUp(tool, v.toScreen);
    const points = [START, { x: START.x + 1.5, y: START.y }];
    BY_ENTER.draw(h, tool, points);
    expectCommitted(h, false, points);
  });

  it('judges the size on screen, not in the image: one image-space path, two zooms', () => {
    // 10 image px: 2.5 screen px zoomed out, 40 zoomed in.
    const points = [START, { x: START.x + 10, y: START.y }];

    const out = new PolylineTool();
    const hOut = setUp(out, ZOOMED_OUT.toScreen);
    BY_ENTER.draw(hOut, out, points);
    expectDiscarded(hOut);

    const inside = new PolylineTool();
    const hIn = setUp(inside, ZOOMED_IN.toScreen);
    BY_ENTER.draw(hIn, inside, points);
    expectCommitted(hIn, false, points);
  });

  it('measures the whole path: vertices 2.9 px either side of the first span 5.8 px and commit', () => {
    // Every vertex is under 3 px from the first, but the path reaches across
    // 5.8 px of screen, and a stroke that long is visible.
    const v = ZOOMED_IN;
    const points = [
      START,
      offsetOnScreen(v, START, { x: 2.9, y: 0 }),
      offsetOnScreen(v, START, { x: -2.9, y: 0 }),
    ];
    const tool = new PolylineTool();
    const h = setUp(tool, v.toScreen);
    BY_ENTER.draw(h, tool, points);
    expectCommitted(h, false, points);
  });

  it('measures the vertices, not the travel: a path out 20 px and back to its start commits', () => {
    const v = ZOOMED_IN;
    const points = [START, offsetOnScreen(v, START, { x: 20, y: 0 }), START];
    const tool = new PolylineTool();
    const h = setUp(tool, v.toScreen);
    BY_ENTER.draw(h, tool, points);
    expectCommitted(h, false, points);
  });

  it('measures in the view at finish, as a drag-to-draw shape is measured on release', () => {
    // Placed 8 screen px apart zoomed in, then zoomed out 16x before Enter:
    // half a screen px by then.
    let current = ZOOMED_IN;
    const tool = new PolylineTool();
    const h = setUp(tool, (p) => current.toScreen(p));
    const points = segment(ZOOMED_IN, 8);
    for (const p of points) click(h, tool, p);
    current = ZOOMED_OUT;
    key(tool, 'Enter');
    expectDiscarded(h);
  });

  for (const f of FINISHES) {
    it(`after ${f.name} discards a path the tool is ready for a new one`, () => {
      const v = ZOOMED_IN;
      const tool = new PolylineTool();
      const h = setUp(tool, v.toScreen);
      f.draw(h, tool, f.closed ? [START, START, START] : [START, START]);
      expectDiscarded(h);
      const discardedAdds = h.canvas.add.mock.calls.length;

      // A new path elsewhere starts afresh: its own preview, and only its own
      // vertices are committed.
      const a = { x: START.x + 50, y: START.y + 40 };
      const b = { x: START.x + 90, y: START.y + 40 };
      click(h, tool, a);
      expect(h.canvas.add.mock.calls.length).toBeGreaterThan(discardedAdds);
      const nextPreview = expectFabricInstance(
        h.canvas.add.mock.calls[discardedAdds]![0],
        Polyline,
      );
      expect(nextPreview).not.toBe(previewOf(h));
      click(h, tool, b);
      key(tool, 'Enter');
      expectCommitted(h, false, [a, b]);
    });
  }
});

/** Press at `from`, move through `moves`, release at the last point reached. */
function stroke(
  tool: FreeHandPathTool,
  from: Point,
  moves: readonly Point[],
  options: { readonly shiftKey?: boolean; readonly beforeRelease?: () => void } = {},
): void {
  const shiftKey = options.shiftKey ?? false;
  tool.onPointerDown({ type: 'pointerdown', shiftKey } as PointerEvent, from);
  for (const p of moves) tool.onPointerMove({ type: 'pointermove', shiftKey } as PointerEvent, p);
  options.beforeRelease?.();
  tool.onPointerUp(
    { type: 'pointerup', shiftKey } as PointerEvent,
    moves[moves.length - 1] ?? from,
  );
}

/** A free-hand stroke's preview is removed and nothing is committed. */
function expectStrokeDiscarded(h: Harness): void {
  expect(h.canvas.add).toHaveBeenCalledTimes(1);
  const preview = expectFabricInstance(h.canvas.add.mock.calls[0]![0], Polyline);
  expect(h.addAnnotation).not.toHaveBeenCalled();
  expect(h.canvas.remove).toHaveBeenCalledWith(preview);
  const removedAt = h.canvas.remove.mock.invocationCallOrder[0]!;
  expect(
    h.canvas.requestRenderAll.mock.invocationCallOrder.some((order) => order > removedAt),
  ).toBe(true);
}

function expectStrokeCommitted(h: Harness, closed: boolean): Polyline {
  expect(h.addAnnotation).toHaveBeenCalledTimes(1);
  const params = h.addAnnotation.mock.calls[0]![0];
  expect(params.type).toBe('freeHandPath');
  return closed
    ? expectFabricInstance(params.fabricObject, Polygon)
    : expectFabricInstance(params.fabricObject, Polyline);
}

describe('FreeHandPathTool: a stroke smaller than MIN_SHAPE_SCREEN_PX on screen is discarded', () => {
  // At the default sampling distance (3 screen px, the same as the minimum) a
  // stroke that stays within a 3 px spot has only its press as a vertex, so it
  // was already discarded for having too few. These pin that.
  for (const v of VIEWS) {
    it(`a tap commits nothing (${v.name})`, () => {
      const tool = new FreeHandPathTool();
      const h = setUp(tool, v.toScreen);
      stroke(tool, START, []);
      expectStrokeDiscarded(h);
    });

    it(`a scribble that never leaves a 3 px spot commits nothing (${v.name})`, () => {
      const tool = new FreeHandPathTool();
      const h = setUp(tool, v.toScreen);
      stroke(tool, START, [
        ...triangle(v, 2.9),
        offsetOnScreen(v, START, { x: -2.9, y: 0 }),
        offsetOnScreen(v, START, { x: 0, y: -2.9 }),
      ]);
      expectStrokeDiscarded(h);
    });
  }

  // A finer sampling distance, which a host can configure, samples several
  // vertices inside the spot: before the minimum, those were committed.
  for (const v of VIEWS) {
    describe(`sampled every screen px (${v.name})`, () => {
      it('a closed stroke 2.9 screen px across is discarded', () => {
        const tool = new FreeHandPathTool({ minSampleDistancePx: 1 });
        const h = setUp(tool, v.toScreen);
        const [, ...moves] = triangle(v, 2.9);
        stroke(tool, START, moves);
        expectStrokeDiscarded(h);
      });

      it('a closed stroke 3.1 screen px across is committed', () => {
        const tool = new FreeHandPathTool({ minSampleDistancePx: 1 });
        const h = setUp(tool, v.toScreen);
        const [, ...moves] = triangle(v, 3.1);
        stroke(tool, START, moves);
        expectStrokeCommitted(h, true);
      });

      it('an open (Shift) stroke 2.9 screen px long is discarded', () => {
        const tool = new FreeHandPathTool({ minSampleDistancePx: 1 });
        const h = setUp(tool, v.toScreen);
        const [, ...moves] = segment(v, 2.9);
        stroke(tool, START, moves, { shiftKey: true });
        expectStrokeDiscarded(h);
      });

      it('an open (Shift) stroke 3.1 screen px long is committed', () => {
        const tool = new FreeHandPathTool({ minSampleDistancePx: 1 });
        const h = setUp(tool, v.toScreen);
        const [, ...moves] = segment(v, 3.1);
        stroke(tool, START, moves, { shiftKey: true });
        expectStrokeCommitted(h, false);
      });
    });
  }

  it('measures in the view at release: a stroke zoomed out under the minimum mid-drag is discarded', () => {
    // Sampled 8 screen px apart zoomed in, then zoomed out 16x before the
    // release: half a screen px across by then.
    let current = ZOOMED_IN;
    const tool = new FreeHandPathTool();
    const h = setUp(tool, (p) => current.toScreen(p));
    const [, ...moves] = triangle(ZOOMED_IN, 8);
    stroke(tool, START, moves, {
      beforeRelease: () => {
        current = ZOOMED_OUT;
      },
    });
    expectStrokeDiscarded(h);
  });

  it('after a discarded stroke the tool is ready for a new one', () => {
    const tool = new FreeHandPathTool({ minSampleDistancePx: 1 });
    const h = setUp(tool, ZOOMED_IN.toScreen);
    const [, ...small] = triangle(ZOOMED_IN, 2.9);
    stroke(tool, START, small);
    expectStrokeDiscarded(h);

    const from = { x: START.x + 50, y: START.y + 40 };
    stroke(tool, from, [
      { x: from.x + 20, y: from.y },
      { x: from.x + 20, y: from.y + 20 },
    ]);
    expect(h.canvas.add).toHaveBeenCalledTimes(3);
    const committed = expectStrokeCommitted(h, true);
    expect(committed).toBe(h.canvas.add.mock.calls[2]![0]);
    expect(committed.points).toEqual([
      from,
      { x: from.x + 20, y: from.y },
      { x: from.x + 20, y: from.y + 20 },
    ]);
  });
});

describe('MIN_SHAPE_SCREEN_PX applies to paths as well', () => {
  it('is the 3 px the tools above are measured against', () => {
    expect(MIN_SHAPE_SCREEN_PX).toBe(3);
  });
});
