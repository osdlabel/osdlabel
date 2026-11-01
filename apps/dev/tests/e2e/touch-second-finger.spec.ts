/**
 * A second finger on the canvas does not leave the first finger's gesture
 * open.
 *
 * OSD's MouseTracker counts touch contacts and calls `releaseHandler` only
 * when the last one lifts. So when the finger that pressed lifted while a
 * second finger was still down, `FabricOverlay` forwarded no release, and
 * Fabric's gesture stayed open: the canvas showed the edit while the stored
 * geometry kept the old shape. The second finger's own lift, which OSD does
 * report, reached Fabric as a non-primary pointer, which Fabric ignores, so
 * that did not end it either. The next movement of any pointer (a mouse
 * hover, a later touch) then carried the shape on, and the next release
 * committed it there. A drawing tool's shape stayed an uncommitted preview
 * until a tap on the toolbar committed it, stretched to the button.
 *
 * The lift of the finger that pressed is a release: the gesture ends there
 * and commits as a mouse release would. The other finger starts nothing until
 * it lifts and presses again. Annotation mode defines no two-finger gesture
 * (OSD's pinch is off there, and it stays off), so that is all a second
 * finger does.
 *
 * Fingers are driven through CDP, which produces the platform's own touch
 * pointer events (the second finger is not primary). Paint is judged from the
 * lower canvas's pixels with the rectangle suite's judge, state from the
 * `annotations-json` readout, and the open gesture from Fabric's own record
 * of it (`_currentTransform`).
 */
import type { CDPSession, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  recordTouchPointers,
  straightPath,
  takeTouchPointers,
  touchLift,
  touchLiftAll,
  touchMove,
  touchPressAndDrag,
  touchStart,
  type Finger,
} from './helpers/touch.js';
import {
  annotationsText,
  bodyPoint,
  boxFromDrag,
  controlOnPage,
  deselect,
  drawRectangle,
  expectGeometryClose,
  expectPaintedAs,
  expectPointClose,
  imageToPage,
  onPixel,
  openAnnotator,
  pageToImage,
  readAnnotations,
  readOnlyRectangle,
  scaleOf,
  selectAt,
  settle,
  type Point,
  type StoredRectangle,
  type View,
} from './rectangle/helpers.js';

// ── What Fabric and OSD hold ─────────────────────────────────────────────

interface Placement {
  readonly left: number;
  readonly top: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly angle: number;
}

interface OverlayProbe {
  readonly canvas: {
    readonly _currentTransform: unknown;
    getObjects(): readonly (Placement & { readonly id?: string })[];
  };
}

interface ViewerProbe {
  readonly viewport: { getZoom(current: boolean): number };
}

/** Whether Fabric has a gesture in progress, and where the one annotation object is. */
async function fabricState(
  page: Page,
): Promise<{ readonly transformOpen: boolean; readonly objects: readonly Placement[] }> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayProbe })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    return {
      transformOpen: overlay.canvas._currentTransform !== null,
      objects: overlay.canvas.getObjects().map((o) => ({
        left: o.left,
        top: o.top,
        scaleX: o.scaleX,
        scaleY: o.scaleY,
        angle: o.angle,
      })),
    };
  });
}

async function onlyPlacement(page: Page): Promise<Placement> {
  const { objects } = await fabricState(page);
  expect(objects, 'expected exactly one object on the canvas').toHaveLength(1);
  return objects[0]!;
}

/**
 * Two placements agree to within `tol`. A commit rebuilds the object from its
 * saved Fabric data, which `toObject()` rounds to 4 decimals, so across one
 * the values agree only to that.
 */
function expectSamePlacement(
  actual: Placement,
  expected: Placement,
  what: string,
  tol = 1e-6,
): void {
  for (const key of ['left', 'top', 'scaleX', 'scaleY', 'angle'] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${what}: ${key} is ${actual[key]}, was ${expected[key]}`,
    ).toBeLessThan(tol);
  }
}

async function zoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdViewer?: ViewerProbe })
      | null;
    const viewer = host?.__osdViewer;
    if (!viewer) throw new Error('viewer test hook not installed');
    return viewer.viewport.getZoom(true);
  });
}

/** The distance from `p` to the segment from `a` to `b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ── Setup ────────────────────────────────────────────────────────────────

/** The fingers: A presses first, B goes down while A is down. */
const A = 1;
const B = 2;

/** The image-space drag the rectangle under test is drawn with, by mouse. */
const DRAWN_FROM: Point = { x: 300.4, y: 250.2 };
const DRAWN_TO: Point = { x: 520.7, y: 400.9 };

/** A page point on empty canvas, well clear of that rectangle: near the bottom-left corner. */
function emptyCanvasPoint(view: View): Point {
  const p = { x: view.canvasOrigin.x + 60, y: view.canvasOrigin.y + view.canvasSize.height - 60 };
  const image = pageToImage(view, p);
  expect(
    image.x < DRAWN_FROM.x - 20 || image.y > DRAWN_TO.y + 20,
    `(${p.x}, ${p.y}) is not clear of the rectangle`,
  ).toBe(true);
  return p;
}

/**
 * Lift finger A while B stays down, and check the page saw exactly that: A's
 * `pointerup` and nothing of B's. Without this a test could pass on a
 * `touchEnd` that lifted both fingers, which OSD reports as a release.
 */
async function liftAWhileBIsDown(cdp: CDPSession, page: Page, a: Finger): Promise<void> {
  await takeTouchPointers(page);
  await touchLift(cdp, [a]);
  const seen = await takeTouchPointers(page);
  expect(seen.map((e) => e.type)).toEqual(['pointerup']);
  expect(seen[0]!.isPrimary, "A's lift is not the primary pointer's").toBe(true);
}

/** B moves on its own, then lifts. */
async function moveAndLiftB(cdp: CDPSession, from: Point): Promise<void> {
  for (const at of straightPath(from, { x: 25, y: -18 }, 5).slice(1)) {
    await touchMove(cdp, [{ id: B, at }]);
  }
  await touchLiftAll(cdp);
}

// ── The select tool ──────────────────────────────────────────────────────

const EDITS: readonly {
  readonly name: string;
  /** The page path finger A drags along. */
  readonly path: (page: Page, view: View, drawn: StoredRectangle) => Promise<Point[]>;
  /** What the stored rectangle must be after the edit, when that is known exactly. */
  readonly expected?: (
    view: View,
    drawn: StoredRectangle,
    path: readonly Point[],
  ) => StoredRectangle;
}[] = [
  {
    name: 'move',
    path: async (_page, view, drawn) =>
      straightPath(bodyPoint(view, drawn.geometry), { x: 11, y: 6 }, 6),
    expected: (view, drawn, path) => {
      const from = pageToImage(view, path[0]!);
      const to = pageToImage(view, path[path.length - 1]!);
      const g = drawn.geometry;
      return {
        id: drawn.id,
        geometry: {
          ...g,
          origin: { x: g.origin.x + to.x - from.x, y: g.origin.y + to.y - from.y },
        },
      };
    },
  },
  {
    name: 'resize',
    path: async (page) => straightPath(onPixel(await controlOnPage(page, 'br')), { x: 9, y: 7 }, 6),
  },
];

test.describe('A second finger does not leave the first finger’s gesture open', () => {
  test.use({ hasTouch: true });

  for (const edit of EDITS) {
    test(`a ${edit.name} is committed where the first finger lifts, though a second stays down`, async ({
      page,
    }) => {
      const view = await openAnnotator(page);
      const drawn = await drawRectangle(page, view, DRAWN_FROM, DRAWN_TO);
      await selectAt(page, bodyPoint(view, drawn.geometry), drawn.id);
      const before = await annotationsText(page);
      const zoomBefore = await zoom(page);
      await recordTouchPointers(page);
      const cdp = await page.context().newCDPSession(page);
      const path = await edit.path(page, view, drawn);
      const aEnd: Finger = { id: A, at: path[path.length - 1]! };
      const bStart = emptyCanvasPoint(view);

      await touchPressAndDrag(cdp, A, path);
      // B goes down on empty canvas, and moves, while A holds the shape.
      await touchStart(cdp, [aEnd, { id: B, at: bStart }]);
      await touchMove(cdp, [aEnd, { id: B, at: { x: bStart.x + 30, y: bStart.y - 20 } }]);
      const held = await onlyPlacement(page);
      expect((await fabricState(page)).transformOpen, 'A never took hold of the shape').toBe(true);

      await liftAWhileBIsDown(cdp, page, aEnd);
      await settle(page, before);

      // Committed: the gesture is over, and the shape is where A left it,
      // both on the canvas and in state.
      expect((await fabricState(page)).transformOpen, "Fabric's gesture is still open").toBe(false);
      const committed = await readOnlyRectangle(page);
      if (edit.expected) {
        const expected = edit.expected(view, drawn, path);
        expectGeometryClose(committed.geometry, expected.geometry, 1 / scaleOf(view));
      }
      const afterLift = await annotationsText(page);
      const placed = await onlyPlacement(page);
      expectSamePlacement(placed, held, 'after A lifted', 1e-3);

      // B, now on its own, moves and lifts: nothing follows it.
      await moveAndLiftB(cdp, { x: bStart.x + 30, y: bStart.y - 20 });
      await settle(page);
      expect(await annotationsText(page), "B's moves or lift changed the annotation").toBe(
        afterLift,
      );
      expectSamePlacement(await onlyPlacement(page), placed, "after B's moves and lift");
      // Annotation mode defines no two-finger gesture: OSD did not pinch.
      expect(await zoom(page)).toBe(zoomBefore);

      // Later input elsewhere: a mouse hover, then a one-finger drag on empty
      // canvas. While the gesture was left open, the first carried the shape
      // after the cursor and the second committed it under the finger.
      const empty = emptyCanvasPoint(view);
      await page.mouse.move(empty.x + 200, empty.y - 150, { steps: 4 });
      await page.mouse.move(empty.x, empty.y, { steps: 4 });
      await touchPressAndDrag(cdp, 3, straightPath(empty, { x: 8, y: -5 }, 4));
      await touchLiftAll(cdp);
      await settle(page);
      expect(await annotationsText(page), 'later input moved the rectangle').toBe(afterLift);

      // What is painted is what is stored.
      await deselect(page);
      await expectPaintedAs(page, committed.geometry, `after the ${edit.name}`);
    });
  }

  // ── Drawing tools ──────────────────────────────────────────────────────

  const DRAWN: readonly {
    readonly tool: 'rectangle' | 'point' | 'freeHandPath';
    /** Checks the one stored annotation against finger A's page path. */
    readonly check: (view: View, stored: { readonly type: string }, path: readonly Point[]) => void;
  }[] = [
    {
      tool: 'rectangle',
      check: (view, stored, path) => {
        expect(stored.type).toBe('rectangle');
        const expected = boxFromDrag(
          pageToImage(view, path[0]!),
          pageToImage(view, path[path.length - 1]!),
        );
        expectGeometryClose(stored as StoredRectangle['geometry'], expected, 1 / scaleOf(view));
      },
    },
    {
      tool: 'point',
      check: (view, stored, path) => {
        expect(stored.type).toBe('point');
        const { position } = stored as { readonly type: string; readonly position?: Point };
        expect(position).toBeDefined();
        expectPointClose(
          position!,
          pageToImage(view, path[path.length - 1]!),
          1 / scaleOf(view),
          'the point',
        );
      },
    },
    {
      tool: 'freeHandPath',
      check: (view, stored, path) => {
        expect(stored.type).toBe('polygon');
        const { points } = stored as { readonly type: string; readonly points?: readonly Point[] };
        expect(points).toBeDefined();
        expect(points!.length).toBeGreaterThanOrEqual(3);
        // Every vertex is on A's stroke, a straight line: none came from B,
        // far off.
        const from = pageToImage(view, path[0]!);
        const to = pageToImage(view, path[path.length - 1]!);
        const tol = 1 / scaleOf(view);
        for (const p of points!) {
          expect(
            distanceToSegment(p, from, to),
            `vertex (${p.x}, ${p.y}) is off A's stroke`,
          ).toBeLessThan(tol);
        }
      },
    },
  ];

  for (const { tool, check } of DRAWN) {
    test(`a ${tool} drawn by the first finger is committed when it lifts, though a second stays down`, async ({
      page,
    }) => {
      const view = await openAnnotator(page);
      await page.getByTestId(`tool-${tool}`).click();
      const before = await annotationsText(page);
      await recordTouchPointers(page);
      const cdp = await page.context().newCDPSession(page);
      const path = straightPath(onPixel(imageToPage(view, DRAWN_FROM)), { x: 15, y: 10 }, 8);
      const aEnd: Finger = { id: A, at: path[path.length - 1]! };
      const bStart = emptyCanvasPoint(view);

      await touchPressAndDrag(cdp, A, path);
      await touchStart(cdp, [aEnd, { id: B, at: bStart }]);
      await touchMove(cdp, [aEnd, { id: B, at: { x: bStart.x + 30, y: bStart.y - 20 } }]);
      await liftAWhileBIsDown(cdp, page, aEnd);
      await settle(page, before);

      const stored = await readAnnotations(page);
      expect(stored).toHaveLength(1);
      check(view, stored[0]!.geometry, path);
      const afterLift = await annotationsText(page);

      // B moves and lifts: it draws nothing. Nor does a tap on the toolbar,
      // which used to commit the open preview, stretched to the button.
      await moveAndLiftB(cdp, { x: bStart.x + 30, y: bStart.y - 20 });
      await settle(page);
      expect(await annotationsText(page)).toBe(afterLift);
      await page.getByTestId('tool-select').click();
      await settle(page);
      expect(await annotationsText(page)).toBe(afterLift);
      expect((await fabricState(page)).objects).toHaveLength(1);

      if (tool === 'rectangle') {
        await deselect(page);
        await expectPaintedAs(
          page,
          stored[0]!.geometry as StoredRectangle['geometry'],
          'the rectangle',
        );
      }
    });
  }
});
