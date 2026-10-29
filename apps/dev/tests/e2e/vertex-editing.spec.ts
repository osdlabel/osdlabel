import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  EMPTY_ALPHA,
  alphasAt,
  annotationsText,
  controlOnPage,
  deselect,
  drag,
  expectPointClose,
  imageToCanvas,
  imageToPage,
  importAnnotations,
  onPixel,
  openAnnotator,
  pageToImage,
  readAnnotations,
  scaleOf,
  selectAt,
  settle,
  storedStrokeWidth,
  type Point,
  type View,
} from './rectangle/helpers.js';

interface StoredAnnotation {
  geometry: { type: string; points?: { x: number; y: number }[] };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

/** Point counts of every polygon/polyline annotation currently in state. */
async function readPolyPointCounts(page: Page): Promise<number[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  const counts: number[] = [];
  for (const imageId of Object.keys(byImage)) {
    for (const id of Object.keys(byImage[imageId]!)) {
      const g = byImage[imageId]![id]!.geometry;
      if ((g.type === 'polygon' || g.type === 'polyline') && g.points) {
        counts.push(g.points.length);
      }
    }
  }
  return counts;
}

test.describe('Polygon vertex editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Load the bundled local image so the viewer opens without network access.
    await page.getByTestId('filmstrip-item-tiled').click();
    // "General" context (index 2) includes the polyline tool.
    await page.selectOption('select', { index: 2 });
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  test('long-press to edit, then insert and delete vertices', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');
    const X = (n: number) => box.x + n;
    const Y = (n: number) => box.y + n;

    // Draw a 4-vertex square polygon, closing on the first vertex.
    await page.getByTestId('tool-polyline').click();
    const verts: [number, number][] = [
      [200, 200],
      [320, 200],
      [320, 320],
      [200, 320],
    ];
    for (const [x, y] of verts) {
      await page.mouse.click(X(x), Y(y));
      await page.waitForTimeout(150);
    }
    // Click near the first vertex (within the close threshold) to finish closed.
    await page.mouse.click(X(202), Y(202));
    await page.waitForTimeout(400);

    expect(await readPolyPointCounts(page)).toEqual([4]);

    // Enter vertex-edit mode with a long-press on the polygon body.
    await page.getByTestId('tool-select').click();
    await page.mouse.move(X(260), Y(260));
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Insert a vertex by dragging the top-edge midpoint handle (260, 200).
    await page.mouse.move(X(260), Y(200));
    await page.mouse.down();
    await page.mouse.move(X(260), Y(150), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect(await readPolyPointCounts(page)).toEqual([5]);

    // Delete a vertex: press a vertex control, then Backspace.
    await page.mouse.click(X(320), Y(320));
    await page.waitForTimeout(200);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);

    expect(await readPolyPointCounts(page)).toEqual([4]);
  });
});

// ── Edge-insert handles commit what they paint ───────────────────────────────

/*
 * Pins that an edge-insert handle commits the vertex it adds, whether the
 * user clicks it or drags it, and that what is painted is then what is
 * stored. Until the fix, a click (press and release without moving) spliced
 * a vertex into the Fabric object at the press point and never committed it:
 * the canvas painted one vertex more than state held, an export left it out,
 * and the next rebuild from state dropped it.
 *
 * A click puts the vertex at the edge's midpoint, wherever on the handle the
 * press lands; a drag puts it where the pointer is released.
 *
 * Mechanics shared with the rectangle suite (the view, the pixel probes,
 * settling, import) come from its helpers; the polygon-specific ones are here.
 * As there, paint is judged from the lower canvas's pixels, and expected
 * positions come from the stored geometry and the view, never from the code
 * under test.
 */

interface PolyGeometry {
  readonly type: 'polygon' | 'polyline';
  readonly points: readonly Point[];
}

interface StoredPoly {
  readonly id: string;
  readonly geometry: PolyGeometry;
  /** How many points the saved Fabric data holds, which is what an import repaints. */
  readonly rawPointCount: number;
}

function isPolyGeometry(g: { readonly type: string }): g is PolyGeometry {
  return (
    (g.type === 'polygon' || g.type === 'polyline') &&
    Array.isArray((g as { readonly points?: unknown }).points)
  );
}

/** The one stored annotation, which must be a polygon or a polyline. */
async function readOnlyPoly(page: Page): Promise<StoredPoly> {
  const all = await readAnnotations(page);
  expect(all, 'expected exactly one stored annotation').toHaveLength(1);
  const only = all[0]!;
  if (!isPolyGeometry(only.geometry)) {
    throw new Error(`the stored annotation is a ${only.geometry.type}, not a polygon or polyline`);
  }
  const raw = only.rawAnnotationData.data['points'];
  if (!Array.isArray(raw)) throw new Error('the saved Fabric data has no points');
  return { id: only.id, geometry: only.geometry, rawPointCount: raw.length };
}

async function storedPointCount(page: Page): Promise<number> {
  return (await readOnlyPoly(page)).geometry.points.length;
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const offset = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });

/**
 * Draw with the polyline tool through `at` (page px): closed into a polygon
 * by clicking next to the first vertex, or finished open with Enter.
 */
async function drawPoly(page: Page, at: readonly Point[], closed: boolean): Promise<StoredPoly> {
  await page.getByTestId('tool-polyline').click();
  const before = await annotationsText(page);
  for (const p of at) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
  }
  if (closed) {
    // Within the tool's 10 px close target around the first vertex.
    await page.mouse.click(at[0]!.x + 2, at[0]!.y + 2);
  } else {
    await page.keyboard.press('Enter');
  }
  await settle(page, before);
  const drawn = await readOnlyPoly(page);
  expect(drawn.geometry.type).toBe(closed ? 'polygon' : 'polyline');
  expect(drawn.geometry.points).toHaveLength(at.length);
  return drawn;
}

/** The control keys of the selected Fabric object (`p0`…, `ins0`… in vertex-edit mode). */
async function activeControls(page: Page): Promise<Record<string, Point>> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdOverlay?: {
            canvas: {
              getActiveObject(): { oCoords?: Record<string, { x: number; y: number }> } | null;
            };
          };
        })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const coords = overlay.canvas.getActiveObject()?.oCoords ?? {};
    return Object.fromEntries(Object.entries(coords).map(([k, c]) => [k, { x: c.x, y: c.y }]));
  });
}

/** Long-press `body` (page px) with the select tool, entering vertex-edit mode. */
async function enterVertexEdit(page: Page, body: Point): Promise<void> {
  await page.getByTestId('tool-select').click();
  await page.mouse.move(body.x, body.y);
  await page.mouse.down();
  // Held past the 500 ms long press.
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect
    .poll(async () => Object.keys(await activeControls(page)), {
      message: 'the long press did not enter vertex-edit mode',
    })
    .toContain('ins0');
}

/**
 * Where vertex-edit control `key` is drawn, in page px, checked against
 * `expected` (image px): a press placed from the geometry then lands on the
 * handle the test means.
 */
async function handleOnPage(page: Page, view: View, key: string, expected: Point): Promise<Point> {
  const at = (await activeControls(page))[key];
  expect(at, `no ${key} control`).toBeDefined();
  const onPage = { x: view.canvasOrigin.x + at!.x, y: view.canvasOrigin.y + at!.y };
  expectPointClose(onPage, imageToPage(view, expected), 0.5, `${key} is not drawn where expected`);
  return onPage;
}

function expectPointsClose(
  actual: readonly Point[],
  expected: readonly Point[],
  tol: number,
  what: string,
): void {
  expect(actual.length, `${what}: ${JSON.stringify(actual)}`).toBe(expected.length);
  expected.forEach((e, i) => expectPointClose(actual[i]!, e, tol, `${what}, point ${i}`));
}

/** Ray-casting point-in-polygon test. */
function inside(p: Point, poly: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

/** Alpha at or above which a pixel is the opaque stroke rather than the 10% fill. */
const STROKE_ALPHA = 128;

/**
 * The painted shape is the stored polygon or polyline `g`, judged by pixels.
 * At a quarter, half and three quarters along every stored edge the stroke
 * is painted; beside each of those points, past the stroke and its
 * antialiasing, a polygon shows only its fill on the inside and nothing on
 * the outside, a polyline nothing on either side. An uncommitted vertex off a
 * stored edge bends the painted edge away from the probes on it. Nothing may
 * be selected (see `deselect`): selection controls paint too.
 */
async function expectPolyPaintedAs(
  page: Page,
  view: View,
  g: PolyGeometry,
  what: string,
): Promise<void> {
  const s = scaleOf(view);
  const away = (await storedStrokeWidth(page)) / 2 + 2.5 / s;
  const closed = g.type === 'polygon';
  const pts = g.points;
  const probes: { name: string; at: Point; expect: 'stroke' | 'fill' | 'empty' }[] = [];
  for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    for (const t of [0.25, 0.5, 0.75]) {
      const on = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      probes.push({ name: `on edge ${i} at ${t}`, at: on, expect: 'stroke' });
      for (const side of [1, -1]) {
        const beside = offset(on, side * away * normal.x, side * away * normal.y);
        probes.push({
          name: `beside edge ${i} at ${t}`,
          at: beside,
          expect: closed && inside(beside, pts) ? 'fill' : 'empty',
        });
      }
    }
  }
  const canvasPoints = probes.map((p) => imageToCanvas(view, p.at));
  const alphas = await alphasAt(page, canvasPoints);
  probes.forEach((probe, i) => {
    const alpha = alphas[i]!;
    const c = canvasPoints[i]!;
    const message = `${what}: ${probe.name} of ${JSON.stringify(g.points)}, canvas (${c.x.toFixed(1)}, ${c.y.toFixed(1)}), alpha ${alpha}`;
    if (probe.expect === 'stroke') {
      expect(alpha, `${message} should be the stroke`).toBeGreaterThanOrEqual(STROKE_ALPHA);
    } else if (probe.expect === 'fill') {
      expect(alpha, `${message} should be the fill`).toBeGreaterThanOrEqual(EMPTY_ALPHA);
      expect(alpha, `${message} should be the fill`).toBeLessThan(STROKE_ALPHA);
    } else {
      expect(alpha, `${message} should be empty`).toBeLessThan(EMPTY_ALPHA);
    }
  });
}

/**
 * The square every polygon test starts from, in canvas px: 120 css px a side
 * at a 2× zoom, so the 2 image px stroke paints 4 css px wide.
 */
const SQUARE_ON_CANVAS: readonly Point[] = [
  { x: 200, y: 200 },
  { x: 320, y: 200 },
  { x: 320, y: 320 },
  { x: 200, y: 320 },
];

const onCanvas = (view: View, p: Point): Point =>
  onPixel({ x: view.canvasOrigin.x + p.x, y: view.canvasOrigin.y + p.y });

/**
 * A press on an insert handle `(3, 4)` css px off its centre: inside the
 * handle's 13 px hit box, as a real press is, and far enough off that a
 * vertex put at the press point instead of the midpoint shows.
 */
const PRESS_OFF_CENTRE = { dx: 3, dy: 4 } as const;

test.describe('Vertex editing: insert handles commit what they paint', () => {
  test('a click on an insert handle commits a vertex at the edge midpoint, which survives export and import', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      SQUARE_ON_CANVAS.map((p) => onCanvas(view, p)),
      true,
    );
    const square = drawn.geometry.points;
    const body = onCanvas(view, { x: 290, y: 290 });
    await enterVertexEdit(page, body);

    const midpoint = mid(square[0]!, square[1]!);
    const handle = await handleOnPage(page, view, 'ins0', midpoint);
    const press = offset(onPixel(handle), PRESS_OFF_CENTRE.dx, PRESS_OFF_CENTRE.dy);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(() => storedPointCount(page), { message: 'the insert click was never committed' })
      .toBe(5);
    await settle(page);
    const inserted = await readOnlyPoly(page);
    expect(inserted.id).toBe(drawn.id);
    expect(inserted.rawPointCount, 'the saved Fabric data left the vertex out').toBe(5);
    const expected = [square[0]!, midpoint, square[1]!, square[2]!, square[3]!];
    expectPointsClose(inserted.geometry.points, expected, 1e-3, 'after the insert click');

    await deselect(page);
    await expectPolyPaintedAs(page, view, inserted.geometry, 'after the insert click');

    // Export, delete, import: the vertex must come back from the saved data.
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const exportPanel = page.locator('textarea');
    await expect(exportPanel).toHaveCount(1);
    const exported = await exportPanel.inputValue();
    await page.getByRole('button', { name: 'X', exact: true }).click();
    await expect(exportPanel).toHaveCount(0);
    await selectAt(page, body, drawn.id);
    await page.keyboard.press('Delete');
    await expect.poll(() => readAnnotations(page)).toEqual([]);
    await deselect(page);
    await importAnnotations(page, exported);

    const loaded = await readOnlyPoly(page);
    expect(loaded.geometry).toEqual(inserted.geometry);
    expect(loaded.rawPointCount).toBe(5);
    await expectPolyPaintedAs(page, view, loaded.geometry, 'after export and import');
    // The rebuilt object holds the vertex too: editing it shows its handle at the midpoint.
    await enterVertexEdit(page, body);
    const keys = Object.keys(await activeControls(page));
    expect(keys.filter((k) => /^p\d+$/.test(k)).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    await handleOnPage(page, view, 'p1', midpoint);
  });

  test('pressing an insert handle and dragging commits the vertex where it is released', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      SQUARE_ON_CANVAS.map((p) => onCanvas(view, p)),
      true,
    );
    const square = drawn.geometry.points;
    await enterVertexEdit(page, onCanvas(view, { x: 290, y: 290 }));

    const handle = await handleOnPage(page, view, 'ins0', mid(square[0]!, square[1]!));
    const from = offset(onPixel(handle), PRESS_OFF_CENTRE.dx, PRESS_OFF_CENTRE.dy);
    const to = offset(onPixel(handle), 0, -40);
    const before = await annotationsText(page);
    await drag(page, from, to, 6);
    await settle(page, before);

    const moved = await readOnlyPoly(page);
    expect(moved.rawPointCount).toBe(5);
    const expected = [square[0]!, pageToImage(view, to), square[1]!, square[2]!, square[3]!];
    expectPointsClose(moved.geometry.points, expected, 0.01, 'after the insert drag');

    await deselect(page);
    await expectPolyPaintedAs(page, view, moved.geometry, 'after the insert drag');
  });

  test('a click on an insert handle of an open polyline commits a vertex at the edge midpoint', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      SQUARE_ON_CANVAS.slice(0, 3).map((p) => onCanvas(view, p)),
      false,
    );
    const path = drawn.geometry.points;
    await enterVertexEdit(page, onCanvas(view, { x: 230, y: 290 }));
    // An open path has no closing edge, so no handle for one.
    expect(Object.keys(await activeControls(page))).not.toContain('ins2');

    const midpoint = mid(path[1]!, path[2]!);
    const handle = await handleOnPage(page, view, 'ins1', midpoint);
    const press = offset(onPixel(handle), PRESS_OFF_CENTRE.dx, PRESS_OFF_CENTRE.dy);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(() => storedPointCount(page), { message: 'the insert click was never committed' })
      .toBe(4);
    await settle(page);
    const inserted = await readOnlyPoly(page);
    expect(inserted.rawPointCount).toBe(4);
    expectPointsClose(
      inserted.geometry.points,
      [path[0]!, path[1]!, midpoint, path[2]!],
      1e-3,
      'after the insert click',
    );

    await deselect(page);
    await expectPolyPaintedAs(page, view, inserted.geometry, 'after the insert click');
  });
});

// ── Deleting a vertex moves no other ─────────────────────────────────────────

/*
 * Pins that Delete in vertex-edit mode removes the one vertex and leaves the
 * others where they were, in what is stored and in what is painted. Until the
 * fix, deleting a vertex that alone held a side of the shape's bounding box
 * moved every other vertex by half the change in the box (Fabric draws the
 * points about the box's centre), on the canvas and in state alike.
 *
 * And that Delete pressed while a vertex is being dragged does nothing: until
 * the fix it deleted the vertex and committed at once, and the drag went on
 * moving whichever vertex took the deleted one's index.
 *
 * Expected shapes come from what was stored before the delete, never from the
 * code under test; paint is judged from the lower canvas's pixels.
 */

/** Turn the selected annotation `degrees` (clockwise on screen) about `centre` (image px) with its rotation handle. */
async function rotateSelected(
  page: Page,
  view: View,
  centre: Point,
  degrees: number,
): Promise<StoredPoly> {
  const before = await annotationsText(page);
  const handle = await controlOnPage(page, 'mtr');
  const c = imageToPage(view, centre);
  const dx = handle.x - c.x;
  const dy = handle.y - c.y;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  const steps = Math.max(6, Math.ceil(Math.abs(degrees) / 5));
  for (let k = 1; k <= steps; k++) {
    const t = (((degrees * k) / steps) * Math.PI) / 180;
    await page.mouse.move(
      c.x + dx * Math.cos(t) - dy * Math.sin(t),
      c.y + dx * Math.sin(t) + dy * Math.cos(t),
    );
  }
  await page.mouse.up();
  await settle(page, before);
  return readOnlyPoly(page);
}

/** Click vertex `index`'s handle, which makes it the delete target, and press Delete. */
async function deleteVertex(
  page: Page,
  view: View,
  g: PolyGeometry,
  index: number,
): Promise<StoredPoly> {
  const handle = await handleOnPage(page, view, `p${index}`, g.points[index]!);
  await page.mouse.click(handle.x, handle.y);
  const before = await annotationsText(page);
  await page.keyboard.press('Delete');
  await settle(page, before);
  return readOnlyPoly(page);
}

const without = <T>(points: readonly T[], index: number): T[] =>
  points.filter((_, i) => i !== index);

test.describe('Vertex editing: deleting a vertex moves no other', () => {
  /**
   * A quadrilateral whose p2 alone is furthest right, at 2 screen px per image
   * px: deleting p2 shrinks the box by 30 image px, which moved every other
   * vertex 15 image px (30 css px) right.
   */
  const QUAD_ON_CANVAS: readonly Point[] = [
    { x: 200, y: 200 },
    { x: 320, y: 200 },
    { x: 380, y: 320 },
    { x: 200, y: 320 },
  ];

  test('deleting the vertex alone furthest right of a polygon leaves the others in place', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      QUAD_ON_CANVAS.map((p) => onCanvas(view, p)),
      true,
    );
    await enterVertexEdit(page, onCanvas(view, { x: 260, y: 260 }));

    const deleted = await deleteVertex(page, view, drawn.geometry, 2);

    expect(deleted.id).toBe(drawn.id);
    expect(deleted.rawPointCount).toBe(3);
    const expected: PolyGeometry = {
      type: 'polygon',
      points: without(drawn.geometry.points, 2),
    };
    expectPointsClose(deleted.geometry.points, expected.points, 1e-3, 'after the delete');
    await deselect(page);
    await expectPolyPaintedAs(page, view, expected, 'after the delete');
  });

  test('deleting a vertex of a rotated polygon leaves the others in place', async ({ page }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      QUAD_ON_CANVAS.map((p) => onCanvas(view, p)),
      true,
    );
    // The box's centre, which Fabric turns the shape about.
    const centre = pageToImage(view, onCanvas(view, { x: 290, y: 260 }));
    await selectAt(page, onCanvas(view, { x: 290, y: 260 }), drawn.id);
    const rotated = await rotateSelected(page, view, centre, 35);
    const turned = Math.atan2(
      rotated.geometry.points[1]!.y - rotated.geometry.points[0]!.y,
      rotated.geometry.points[1]!.x - rotated.geometry.points[0]!.x,
    );
    expect(Math.abs((turned * 180) / Math.PI), 'the polygon did not turn').toBeGreaterThan(20);
    await enterVertexEdit(page, onCanvas(view, { x: 290, y: 260 }));

    const deleted = await deleteVertex(page, view, rotated.geometry, 2);

    expect(deleted.rawPointCount).toBe(3);
    const expected: PolyGeometry = {
      type: 'polygon',
      points: without(rotated.geometry.points, 2),
    };
    expectPointsClose(deleted.geometry.points, expected.points, 1e-3, 'after the delete');
    await deselect(page);
    await expectPolyPaintedAs(page, view, expected, 'after the delete');
  });

  test("deleting an open polyline's first vertex, alone furthest left, leaves the others in place", async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      [
        { x: 200, y: 260 },
        { x: 320, y: 200 },
        { x: 380, y: 320 },
      ].map((p) => onCanvas(view, p)),
      false,
    );
    await enterVertexEdit(page, onCanvas(view, { x: 290, y: 260 }));

    const deleted = await deleteVertex(page, view, drawn.geometry, 0);

    expect(deleted.rawPointCount).toBe(2);
    const expected: PolyGeometry = {
      type: 'polyline',
      points: without(drawn.geometry.points, 0),
    };
    expectPointsClose(deleted.geometry.points, expected.points, 1e-3, 'after the delete');
    await deselect(page);
    await expectPolyPaintedAs(page, view, expected, 'after the delete');
  });

  test('Delete while a vertex is dragged does nothing; after the release it deletes that vertex', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 2 });
    const drawn = await drawPoly(
      page,
      SQUARE_ON_CANVAS.map((p) => onCanvas(view, p)),
      true,
    );
    const square = drawn.geometry.points;
    await enterVertexEdit(page, onCanvas(view, { x: 260, y: 260 }));

    const from = onPixel(await handleOnPage(page, view, 'p2', square[2]!));
    const midway = offset(from, 20, 14);
    const to = offset(from, 40, 28);
    const before = await annotationsText(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(midway.x, midway.y, { steps: 4 });
    await page.keyboard.press('Delete');
    await settle(page);
    expect(await annotationsText(page), 'Delete mid-drag committed').toBe(before);
    expect(
      Object.keys(await activeControls(page))
        .filter((k) => /^p\d+$/.test(k))
        .sort(),
      'Delete mid-drag removed a vertex',
    ).toEqual(['p0', 'p1', 'p2', 'p3']);
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await settle(page, before);

    const dragged = await readOnlyPoly(page);
    expect(dragged.rawPointCount).toBe(4);
    expectPointsClose(
      dragged.geometry.points,
      [square[0]!, square[1]!, pageToImage(view, to), square[3]!],
      0.01,
      'after the drag',
    );

    // Released, Delete works again, on the vertex just dragged.
    const afterDrag = await annotationsText(page);
    await page.keyboard.press('Delete');
    await settle(page, afterDrag);
    const deleted = await readOnlyPoly(page);
    expect(deleted.rawPointCount).toBe(3);
    const expected: PolyGeometry = { type: 'polygon', points: without(dragged.geometry.points, 2) };
    expectPointsClose(deleted.geometry.points, expected.points, 1e-3, 'after the delete');
    await deselect(page);
    await expectPolyPaintedAs(page, view, expected, 'after the delete');
  });
});
