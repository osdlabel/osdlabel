/**
 * The minimum-size rule every drag-to-draw tool shares (`ShapeTool`): a
 * gesture whose shape would be smaller than `MIN_SHAPE_SCREEN_PX` on screen is
 * discarded on release instead of committed, with its preview removed.
 *
 * Before it, a click without a drag committed a zero-size rectangle, circle or
 * line: invisible, yet carrying decorations and counting against the context's
 * `maxCount` (two stray clicks used up a 2-rectangle quota).
 *
 * Sizes here are chosen on screen and converted to image px through the view,
 * so the same case reads the same at every zoom; the views include a rotated
 * and mirrored one, under which a rectangle's sides are no longer its screen
 * bounding box.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { Circle, Line, Rect, type FabricObject } from 'fabric';
import type { AnnotationStyle, Point, ToolType } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { MIN_SHAPE_SCREEN_PX, ShapeTool } from '../../../src/tools/shape-tool.js';
import * as barrel from '../../../src/index.js';
import { RectangleTool } from '../../../src/tools/rectangle-tool.js';
import { CircleTool } from '../../../src/tools/circle-tool.js';
import { LineTool } from '../../../src/tools/line-tool.js';
import { PointTool } from '../../../src/tools/point-tool.js';
import type { FabricShapeOptions } from '../../../src/fabric-utils.js';
import type { AddAnnotationParams, ToolCallbacks } from '../../../src/tools/base-tool.js';
import {
  createMockCanvas,
  createMockToolOverlay,
  createTestKeyboardShortcuts,
  type MockFabricCanvas,
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

const VIEWS: readonly View[] = [
  view('zoomed out, 0.25 screen px per image px', 0.25, 0, false),
  view('zoomed in, 4 screen px per image px', 4, 0, false),
  view('rotated 30° and mirrored, at 2 screen px per image px', 2, 30, true),
];

/** An image-space point to start every gesture from. */
const START: Point = { x: 400, y: 300 };

interface Harness {
  readonly canvas: MockFabricCanvas;
  readonly addAnnotation: Mock<(params: AddAnnotationParams) => void>;
}

function setUp(tool: ShapeTool<FabricObject>, v: View): Harness {
  const canvas = createMockCanvas();
  // Both routes to the scale agree, so the rule is pinned whichever one the
  // tool reads.
  canvas.getZoom.mockReturnValue(v.zoom);
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
  tool.activate(
    createMockToolOverlay(canvas, v.toScreen),
    imageId,
    callbacks,
    createTestKeyboardShortcuts(),
  );
  return { canvas, addAnnotation };
}

/** Press at `from`, move to each of `moves`, release at the last point reached. */
function gesture(tool: ShapeTool<FabricObject>, from: Point, moves: readonly Point[]): void {
  tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, from);
  for (const p of moves) tool.onPointerMove({ type: 'pointermove' } as PointerEvent, p);
  tool.onPointerUp({ type: 'pointerup' } as PointerEvent, moves[moves.length - 1] ?? from);
}

/** `from` plus a screen-space offset, in image space (the view's linear part, inverted). */
function offsetOnScreen(v: View, from: Point, screen: Point): Point {
  // Invert the 2x2 part of `toScreen` numerically from its images of the axes.
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

/** The preview the tool put on the canvas: the first object added. */
function previewOf(h: Harness): FabricObject {
  expect(h.canvas.add).toHaveBeenCalled();
  return h.canvas.add.mock.calls[0]![0];
}

function expectDiscarded(h: Harness): void {
  const preview = previewOf(h);
  expect(h.addAnnotation).not.toHaveBeenCalled();
  expect(h.canvas.remove).toHaveBeenCalledWith(preview);
  // The removal is painted, not left for some later render to pick up.
  const removedAt = h.canvas.remove.mock.invocationCallOrder[0]!;
  expect(
    h.canvas.requestRenderAll.mock.invocationCallOrder.some((order) => order > removedAt),
  ).toBe(true);
}

function expectCommitted(h: Harness, type: ToolType): void {
  const preview = previewOf(h);
  expect(h.addAnnotation).toHaveBeenCalledTimes(1);
  const params = h.addAnnotation.mock.calls[0]![0];
  expect(params.type).toBe(type);
  expect(params.fabricObject).toBe(preview);
  expect(h.canvas.remove).not.toHaveBeenCalled();
}

/**
 * Each drag-to-draw tool, and the gesture that draws a shape whose measured
 * screen size is `size` px (the smaller side of a rectangle, a circle's
 * diameter, a line's length), from `START` in view `v`.
 */
interface ToolCase {
  readonly name: string;
  readonly type: ToolType;
  readonly make: () => ShapeTool<FabricObject>;
  readonly ends: (v: View, size: number) => readonly Point[];
}

const TOOLS: readonly ToolCase[] = [
  {
    name: 'a rectangle short in y',
    type: 'rectangle',
    make: () => new RectangleTool(),
    // A long, thin box: 40 px along one image axis, `size` along the other.
    // Under the rotated view its screen bounding box is much larger than
    // `size`, so only measuring its sides gets the thin case right.
    ends: (v, size) => [{ x: START.x + 40 / v.zoom, y: START.y + size / v.zoom }],
  },
  {
    name: 'a rectangle short in x',
    type: 'rectangle',
    make: () => new RectangleTool(),
    // The same, thin the other way.
    ends: (v, size) => [{ x: START.x + size / v.zoom, y: START.y - 40 / v.zoom }],
  },
  {
    name: 'a circle',
    type: 'circle',
    make: () => new CircleTool(),
    // The drag is the radius; the diameter is what is measured.
    ends: (v, size) => [offsetOnScreen(v, START, { x: (size / 2) * 0.6, y: (size / 2) * 0.8 })],
  },
  {
    name: 'a line',
    type: 'line',
    make: () => new LineTool(),
    // Diagonal on screen, so a per-axis check would see neither component.
    ends: (v, size) => [offsetOnScreen(v, START, { x: -size * 0.6, y: size * 0.8 })],
  },
];

describe('MIN_SHAPE_SCREEN_PX', () => {
  it('is 3 screen px, and exported from the package', () => {
    expect(MIN_SHAPE_SCREEN_PX).toBe(3);
    expect(barrel.MIN_SHAPE_SCREEN_PX).toBe(3);
  });
});

describe('ShapeTool: a shape smaller than MIN_SHAPE_SCREEN_PX on screen is discarded', () => {
  for (const v of VIEWS) {
    describe(v.name, () => {
      for (const c of TOOLS) {
        it(`${c.name}: a click without a drag commits nothing and removes the preview`, () => {
          const tool = c.make();
          const h = setUp(tool, v);
          gesture(tool, START, []);
          expectDiscarded(h);
        });

        it(`${c.name}: 2.9 screen px is discarded`, () => {
          const tool = c.make();
          const h = setUp(tool, v);
          gesture(tool, START, c.ends(v, 2.9));
          expectDiscarded(h);
        });

        it(`${c.name}: 3.1 screen px is committed`, () => {
          const tool = c.make();
          const h = setUp(tool, v);
          gesture(tool, START, c.ends(v, 3.1));
          expectCommitted(h, c.type);
        });
      }
    });
  }

  it('the minimum is inclusive: exactly 3 screen px is committed', () => {
    // Zoom 2 and image sizes of 1.5 px make every measurement exactly 3.
    const v = view('zoom 2', 2, 0, false);
    const cases: [ToolCase['make'], ToolType, Point][] = [
      [() => new RectangleTool(), 'rectangle', { x: START.x + 1.5, y: START.y + 1.5 }],
      [() => new CircleTool(), 'circle', { x: START.x + 0.75, y: START.y }],
      [() => new LineTool(), 'line', { x: START.x, y: START.y - 1.5 }],
    ];
    for (const [make, type, end] of cases) {
      const tool = make();
      const h = setUp(tool, v);
      gesture(tool, START, [end]);
      expectCommitted(h, type);
    }
  });

  it('judges the size on screen, not in the image: one image-space box, two zooms', () => {
    // 10 x 10 image px: 2.5 screen px zoomed out, 40 zoomed in.
    const end = { x: START.x + 10, y: START.y + 10 };

    const out = new RectangleTool();
    const hOut = setUp(out, VIEWS[0]!);
    gesture(out, START, [end]);
    expectDiscarded(hOut);

    const inside = new RectangleTool();
    const hIn = setUp(inside, VIEWS[1]!);
    gesture(inside, START, [end]);
    expectCommitted(hIn, 'rectangle');
  });

  it('a drag that returns to its start is discarded: the shape is measured, not the travel', () => {
    // A drag out to 20 px and back to the press point is a click by the time
    // it is released.
    const v = VIEWS[1]!;
    const tool = new LineTool();
    const h = setUp(tool, v);
    gesture(tool, START, [{ x: START.x + 20 / v.zoom, y: START.y }, START]);
    expectDiscarded(h);
  });

  it('after a discarded click the tool is idle, and the next drag draws normally', () => {
    const v = VIEWS[1]!;
    const tool = new RectangleTool();
    const h = setUp(tool, v);
    gesture(tool, START, []);
    expectDiscarded(h);

    // A stray release or move with no press does nothing.
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 900, y: 900 });
    tool.onPointerUp({ type: 'pointerup' } as PointerEvent, { x: 900, y: 900 });
    expect(h.addAnnotation).not.toHaveBeenCalled();

    const next = { x: START.x + 50, y: START.y + 40 };
    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, START);
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, next);
    tool.onPointerUp({ type: 'pointerup' } as PointerEvent, next);
    expect(h.canvas.add).toHaveBeenCalledTimes(2);
    const second = h.canvas.add.mock.calls[1]![0];
    expect(second).toBeInstanceOf(Rect);
    expect(h.addAnnotation).toHaveBeenCalledTimes(1);
    expect(h.addAnnotation.mock.calls[0]![0].fabricObject).toBe(second);
    expect(second.width).toBe(50);
    expect(second.height).toBe(40);
  });
});

describe('ShapeTool: shapes the minimum does not apply to', () => {
  for (const v of VIEWS) {
    it(`a point is placed by a click (${v.name})`, () => {
      const tool = new PointTool();
      const h = setUp(tool, v);
      gesture(tool, START, []);
      expectCommitted(h, 'point');
      expect(previewOf(h)).toBeInstanceOf(Circle);
    });
  }

  it('a ShapeTool subclass that does not measure its shape commits a click, as before', () => {
    // Hosts can extend ShapeTool; one written before the minimum existed must
    // keep its behaviour rather than start discarding.
    class MarkerTool extends ShapeTool<Line> {
      readonly type: ToolType = 'line';
      protected createPreview(p: Point, options: FabricShapeOptions, _style: AnnotationStyle) {
        return new Line([p.x, p.y, p.x, p.y], options);
      }
      protected updatePreview(): void {}
    }
    const tool = new MarkerTool();
    const h = setUp(tool, VIEWS[1]!);
    gesture(tool, START, []);
    expectCommitted(h, 'line');
  });
});
