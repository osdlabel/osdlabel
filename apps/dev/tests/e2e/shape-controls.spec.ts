/**
 * Pins, through the real input routing, that the select tool's handles cannot
 * turn a circle into a shape its geometry cannot describe, and that lines and
 * polygons keep Fabric's own handles:
 *
 * - a circle has four corner handles and a rotation handle, and no side
 *   handles. Fabric's defaults let a side handle, or Shift + a corner (its
 *   `uniScaleKey`), stretch a circle into an ellipse, and Shift + a side
 *   handle (its `altActionKey`) shear it, while the stored geometry stayed a
 *   circle;
 * - Shift + a corner handle scales a circle uniformly, about the opposite
 *   corner of its box;
 * - Shift + a press where a side handle was takes the circle's body: it moves
 *   the circle, and nothing is sheared;
 * - Shift + a side handle still shears a line or a polygon, whose stored
 *   points are read through the whole transform, so they follow the shear;
 * - and their measurement label follows the shear while it is dragged, as it
 *   follows a move, a resize or a rotation. Fabric reports a shear with
 *   `object:skewing`, which the live decorations did not listen for, so the
 *   label stayed put for the whole drag and jumped on release.
 *
 * After every edit the painted pixels are judged against the stored geometry.
 * Rectangles are covered by the rectangle suite (`rectangle/rectangle-shift.spec.ts`).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  EMPTY_ALPHA,
  alphasAt,
  annotationsText,
  controlOnPage,
  deselect,
  drag,
  imageToCanvas,
  imageToPage,
  onPixel,
  openAnnotator,
  paintedBounds,
  readAnnotations,
  readView,
  scaleOf,
  selectAt,
  settle,
  type Point,
  type StoredAnnotation,
  type View,
} from './rectangle/helpers.js';

const SCALE = 1.37;

interface CircleGeometry {
  readonly type: 'circle';
  readonly center: Point;
  readonly radius: number;
}

interface PointsGeometry {
  readonly type: 'line' | 'polygon';
  readonly points: readonly Point[];
}

/** The one stored annotation. */
async function readOnly(page: Page): Promise<StoredAnnotation> {
  const all = await readAnnotations(page);
  expect(all, 'expected exactly one stored annotation').toHaveLength(1);
  return all[0]!;
}

async function readOnlyCircle(page: Page): Promise<{ id: string; geometry: CircleGeometry }> {
  const only = await readOnly(page);
  const g = only.geometry as { type: string; center?: Point; radius?: number };
  if (g.type !== 'circle' || g.center === undefined || g.radius === undefined) {
    throw new Error(`the stored annotation is a ${g.type}, not a circle`);
  }
  return { id: only.id, geometry: { type: 'circle', center: g.center, radius: g.radius } };
}

/** A stored line or polygon as its points: a line's are its start and end. */
async function readOnlyPoints(page: Page): Promise<{ id: string; geometry: PointsGeometry }> {
  const only = await readOnly(page);
  const g = only.geometry as { type: string; start?: Point; end?: Point; points?: Point[] };
  if (g.type === 'line' && g.start !== undefined && g.end !== undefined) {
    return { id: only.id, geometry: { type: 'line', points: [g.start, g.end] } };
  }
  if (g.type === 'polygon' && g.points !== undefined) {
    return { id: only.id, geometry: { type: 'polygon', points: g.points } };
  }
  throw new Error(`the stored annotation is a ${g.type}, not a line or a polygon`);
}

/** The stored Fabric data's fields named `keys`. */
async function storedData(page: Page, keys: readonly string[]): Promise<Record<string, unknown>> {
  const data = (await readOnly(page)).rawAnnotationData.data;
  return Object.fromEntries(keys.map((k) => [k, data[k]]));
}

async function storedStrokeWidth(page: Page): Promise<number> {
  const { strokeWidth } = await storedData(page, ['strokeWidth']);
  if (typeof strokeWidth !== 'number') throw new Error(`strokeWidth is ${String(strokeWidth)}`);
  return strokeWidth;
}

/** The names of the selected object's controls. */
async function activeControlNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdOverlay?: {
            canvas: {
              getActiveObject(): { oCoords?: Record<string, unknown> } | null | undefined;
            };
          };
        })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const active = overlay.canvas.getActiveObject();
    if (!active?.oCoords) throw new Error('nothing is selected');
    return Object.keys(active.oCoords).sort();
  });
}

/** Run `gesture` holding Shift, pressed before it and released after. */
async function withShift(page: Page, gesture: () => Promise<void>): Promise<void> {
  await page.keyboard.down('Shift');
  try {
    await gesture();
  } finally {
    await page.keyboard.up('Shift');
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────────

const CENTRE: Point = { x: 640.4, y: 380.3 };
const RADIUS = 70;

async function drawCircle(page: Page, view: View) {
  await page.getByTestId('tool-circle').click();
  const before = await annotationsText(page);
  await drag(
    page,
    onPixel(imageToPage(view, CENTRE)),
    onPixel(imageToPage(view, { x: CENTRE.x + RADIUS, y: CENTRE.y })),
    6,
  );
  await settle(page, before);
  return readOnlyCircle(page);
}

/** A page point on the circle's body below its centre: clear of the badge above it and the label to its right. */
function circleBody(view: View, g: CircleGeometry): Point {
  return onPixel(imageToPage(view, { x: g.center.x, y: g.center.y + g.radius / 2 }));
}

/** Click `vertices` with the polyline tool, then the first again to close it into a polygon. */
async function drawPolygon(page: Page, view: View, vertices: readonly Point[]) {
  await page.getByTestId('tool-polyline').click();
  const before = await annotationsText(page);
  for (const v of vertices) {
    const at = onPixel(imageToPage(view, v));
    await page.mouse.click(at.x, at.y);
  }
  const first = onPixel(imageToPage(view, vertices[0]!));
  await page.mouse.click(first.x + 2, first.y + 2);
  await settle(page, before);
  return readOnlyPoints(page);
}

async function drawLine(page: Page, view: View, a: Point, b: Point) {
  await page.getByTestId('tool-line').click();
  const before = await annotationsText(page);
  await drag(page, onPixel(imageToPage(view, a)), onPixel(imageToPage(view, b)), 6);
  await settle(page, before);
  return readOnlyPoints(page);
}

// ── Paint vs geometry ────────────────────────────────────────────────────────

interface Probe {
  readonly name: string;
  readonly at: Point;
  readonly painted: boolean;
}

async function expectProbes(page: Page, view: View, probes: readonly Probe[], what: string) {
  const canvasPoints = probes.map((p) => imageToCanvas(view, p.at));
  const alphas = await alphasAt(page, canvasPoints);
  probes.forEach((probe, i) => {
    const at = canvasPoints[i]!;
    const message = `${what}: ${probe.name}, canvas (${at.x.toFixed(1)}, ${at.y.toFixed(1)})`;
    if (probe.painted) {
      expect(alphas[i]!, `${message} should be painted`).toBeGreaterThanOrEqual(EMPTY_ALPHA);
    } else {
      expect(alphas[i]!, `${message} should be empty`).toBeLessThan(EMPTY_ALPHA);
    }
  });
}

/**
 * The painted shape is the stored circle `g`, judged by pixels: just inside
 * its outline is painted and just outside its stroke is not, in 16 directions,
 * and the box around every painted pixel is the box around its stroke.
 */
async function expectCirclePaintedAs(page: Page, g: CircleGeometry, what: string) {
  const view = await readView(page);
  const s = scaleOf(view);
  const half = (await storedStrokeWidth(page)) / 2;
  const inset = 2 / s;
  const outset = half + 2.5 / s;
  const probes: Probe[] = [{ name: 'the centre', at: g.center, painted: true }];
  for (let k = 0; k < 16; k++) {
    const t = (k * Math.PI) / 8;
    const u = { x: Math.cos(t), y: Math.sin(t) };
    probes.push(
      {
        name: `inside at ${k * 22.5}°`,
        at: { x: g.center.x + (g.radius - inset) * u.x, y: g.center.y + (g.radius - inset) * u.y },
        painted: true,
      },
      {
        name: `outside at ${k * 22.5}°`,
        at: {
          x: g.center.x + (g.radius + outset) * u.x,
          y: g.center.y + (g.radius + outset) * u.y,
        },
        painted: false,
      },
    );
  }
  await expectProbes(page, view, probes, `${what} (${JSON.stringify(g)})`);

  const r = g.radius + half;
  const topLeft = imageToCanvas(view, { x: g.center.x - r, y: g.center.y - r });
  const bottomRight = imageToCanvas(view, { x: g.center.x + r, y: g.center.y + r });
  const painted = await paintedBounds(page);
  expect(painted, `${what}: nothing is painted`).not.toBeNull();
  const expected = { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
  for (const side of ['minX', 'minY', 'maxX', 'maxY'] as const) {
    expect(
      Math.abs(painted![side] - expected[side]),
      `${what}: painted ${side} ${painted![side]}, the stored circle's ${expected[side]}`,
    ).toBeLessThanOrEqual(1.5);
  }
}

/**
 * The painted shape is the stored line or polygon, judged by pixels: each
 * stored edge is painted at its quarter points, and empty a stroke and a bit
 * to either side of them (outside only, for a polygon, whose inside is filled).
 */
async function expectEdgesPaintedAs(page: Page, g: PointsGeometry, what: string) {
  const view = await readView(page);
  const s = scaleOf(view);
  const off = (await storedStrokeWidth(page)) / 2 + 2.5 / s;
  const points = g.points;
  const edges = g.type === 'line' ? [[0, 1]] : points.map((_, i) => [i, (i + 1) % points.length]);
  // A polygon's points wind one way or the other; its outward side is away from the centroid.
  const centroid = {
    x: points.reduce((a, p) => a + p.x, 0) / points.length,
    y: points.reduce((a, p) => a + p.y, 0) / points.length,
  };
  const probes: Probe[] = [];
  for (const [i, j] of edges) {
    const a = points[i!]!;
    const b = points[j!]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((mid.x - centroid.x) * n.x + (mid.y - centroid.y) * n.y < 0) n = { x: -n.x, y: -n.y };
    for (const f of [0.25, 0.5, 0.75]) {
      const on = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      probes.push(
        { name: `edge ${i}-${j} at ${f}`, at: on, painted: true },
        {
          name: `outside edge ${i}-${j} at ${f}`,
          at: { x: on.x + n.x * off, y: on.y + n.y * off },
          painted: false,
        },
      );
      if (g.type === 'line') {
        probes.push({
          name: `the other side of the line at ${f}`,
          at: { x: on.x - n.x * off, y: on.y - n.y * off },
          painted: false,
        });
      }
    }
  }
  await expectProbes(page, view, probes, `${what} (${JSON.stringify(g.points)})`);
}

// ── Labels ───────────────────────────────────────────────────────────────────

/**
 * The points Fabric paints for the selected line's ends or polygon's vertices
 * at this moment, in image px: its own points through its whole transform, as
 * the canvas draws them. Read mid-drag, this is the shape on screen, which
 * state does not hold until the release.
 */
async function paintedPointsOfSelection(page: Page): Promise<Point[]> {
  return page.evaluate(() => {
    interface Shape {
      calcTransformMatrix(): number[];
      points?: { x: number; y: number }[];
      pathOffset?: { x: number; y: number };
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
    }
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: { canvas: { getActiveObject(): Shape | null | undefined } } })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const active = overlay.canvas.getActiveObject();
    if (!active) throw new Error('nothing is selected');
    const [a, b, c, d, e, f] = active.calcTransformMatrix() as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    let local: { x: number; y: number }[];
    if (active.points && active.pathOffset) {
      const offset = active.pathOffset;
      local = active.points.map((p) => ({ x: p.x - offset.x, y: p.y - offset.y }));
    } else if (
      active.x1 !== undefined &&
      active.y1 !== undefined &&
      active.x2 !== undefined &&
      active.y2 !== undefined
    ) {
      const hx = (active.x2 - active.x1) / 2;
      const hy = (active.y2 - active.y1) / 2;
      local = [
        { x: -hx, y: -hy },
        { x: hx, y: hy },
      ];
    } else {
      throw new Error('the selection is not a line or a polygon');
    }
    return local.map((p) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }));
  });
}

function meanOf(points: readonly Point[]): Point {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/** The summed length of the path through `points`, closed back to the first when `closed`. */
function pathLength(points: readonly Point[], closed: boolean): number {
  let total = 0;
  const edges = closed ? points.length : points.length - 1;
  for (let i = 0; i < edges; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    total += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return total;
}

/**
 * Where the dev app's measurement label of a line or polygon must sit, and
 * what it must read, for the shape painted at `points` (image px): centred on
 * a polygon's centroid, reading its perimeter; or with its bottom edge 6
 * screen px above a line's midpoint, reading its length. The dev app's pixel
 * spacing is 1 px per image px, so both read in image px.
 */
function expectedLabel(
  view: View,
  type: 'line' | 'polygon',
  points: readonly Point[],
): { readonly at: Point; readonly name: 'P' | 'L'; readonly value: number } {
  const centre = imageToPage(view, meanOf(points));
  return type === 'polygon'
    ? { at: centre, name: 'P', value: pathLength(points, true) }
    : { at: { x: centre.x, y: centre.y - 6 }, name: 'L', value: pathLength(points, false) };
}

/** Where the label sits, by the same reference point `expectedLabel` gives: its centre, or its bottom centre. */
async function labelAt(page: Page, id: string, type: 'line' | 'polygon'): Promise<Point> {
  const box = await page
    .locator(`[data-osdlabel="decoration-text"][data-decoration-id="measurement:${id}"]`)
    .boundingBox();
  if (!box) throw new Error(`the measurement label of ${id} is not laid out`);
  return type === 'polygon'
    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : { x: box.x + box.width / 2, y: box.y + box.height };
}

async function labelReading(page: Page, id: string, name: 'P' | 'L'): Promise<number> {
  const text =
    (await page
      .locator(`[data-osdlabel="decoration-text"][data-decoration-id="measurement:${id}"]`)
      .textContent()) ?? '';
  const match = new RegExp(`^${name}: ([\\d.]+) px$`, 'm').exec(text);
  if (!match) throw new Error(`the label "${text}" has no ${name} in px`);
  return Number(match[1]);
}

// ── Circles ──────────────────────────────────────────────────────────────────

test.describe('Shape controls: circles', () => {
  test('a selected circle has corner and rotation handles, and no side handles', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const { id, geometry } = await drawCircle(page, view);
    await selectAt(page, circleBody(view, geometry), id);
    expect(await activeControlNames(page)).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
  });

  test('Shift + a corner handle scales a circle uniformly, about the opposite corner', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const { id, geometry: g0 } = await drawCircle(page, view);
    await selectAt(page, circleBody(view, g0), id);

    const before = await annotationsText(page);
    const from = await controlOnPage(page, 'br');
    // Further right than up: a free scale would stretch it into an ellipse.
    await withShift(page, () => drag(page, from, { x: from.x + 50, y: from.y - 30 }, 8));
    await settle(page, before);

    const { geometry: g1 } = await readOnlyCircle(page);
    const data = await storedData(page, ['scaleX', 'scaleY', 'skewX', 'skewY']);
    expect(data['scaleX'], 'scaled uniformly').toBe(data['scaleY']);
    expect(data).toMatchObject({ skewX: 0, skewY: 0 });
    expect(g1.radius).toBeGreaterThan(g0.radius + 2);
    // The box's top-left corner stays put.
    expect(g1.center.x - g1.radius).toBeCloseTo(g0.center.x - g0.radius, 1);
    expect(g1.center.y - g1.radius).toBeCloseTo(g0.center.y - g0.radius, 1);

    await deselect(page);
    await expectCirclePaintedAs(page, g1, 'after Shift + br');
  });

  test('Shift + a press where a side handle was moves the circle; nothing is sheared', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const { id, geometry: g0 } = await drawCircle(page, view);
    // Selecting the circle re-flows the header, and the view with it: aim the
    // press, and read the drag's length in image px, in the view it runs in.
    const selected = await selectAt(page, circleBody(view, g0), id);

    // 4 screen px inside the rightmost point, where Fabric's mr handle was:
    // with Shift, dragging it down would have sheared the circle.
    const s = scaleOf(selected);
    const edge = imageToPage(selected, { x: g0.center.x + g0.radius, y: g0.center.y });
    const from = onPixel({ x: edge.x - 4, y: edge.y });
    const before = await annotationsText(page);
    await withShift(page, () => drag(page, from, { x: from.x, y: from.y + 40 }, 8));
    await settle(page, before);

    const { geometry: g1 } = await readOnlyCircle(page);
    expect(await storedData(page, ['scaleX', 'scaleY', 'skewX', 'skewY'])).toEqual({
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
    });
    expect(g1.radius).toBeCloseTo(g0.radius, 3);
    expect(g1.center.x).toBeCloseTo(g0.center.x, 2);
    expect(Math.abs(g1.center.y - (g0.center.y + 40 / s))).toBeLessThanOrEqual(0.5);

    await deselect(page);
    await expectCirclePaintedAs(page, g1, 'after Shift + a press on its right edge');
  });
});

// ── Lines and polygons ───────────────────────────────────────────────────────

test.describe("Shape controls: lines and polygons keep Fabric's", () => {
  /**
   * Shift + the bottom handle dragged sideways: Fabric shears the shape about
   * its top edge (moving the bottom edge by twice the drag, as its skew
   * handler assumes a centred skew; the factor is Fabric's, not pinned here).
   */
  async function shearFromBottom(page: Page, view: View, id: string, body: Point) {
    await selectAt(page, onPixel(imageToPage(view, body)), id);
    expect(await activeControlNames(page)).toEqual([
      'bl',
      'br',
      'mb',
      'ml',
      'mr',
      'mt',
      'mtr',
      'tl',
      'tr',
    ]);
    const before = await annotationsText(page);
    const from = await controlOnPage(page, 'mb');
    await withShift(page, () => drag(page, from, { x: from.x + 40, y: from.y }, 8));
    await settle(page, before);
  }

  test('Shift + the bottom handle shears a polygon, and its stored points are the painted ones', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const square = [
      { x: 560.2, y: 320.4 },
      { x: 720.6, y: 320.4 },
      { x: 720.6, y: 440.8 },
      { x: 560.2, y: 440.8 },
    ];
    const drawn = await drawPolygon(page, view, square);
    await shearFromBottom(page, view, drawn.id, { x: 600, y: 400 });

    // Fabric's own handle, kept: the shear is in the data and in the points.
    const { skewX } = await storedData(page, ['skewX']);
    expect(typeof skewX === 'number' && skewX > 5, `skewX ${String(skewX)}`).toBe(true);
    const { geometry: g1 } = await readOnlyPoints(page);
    const s = scaleOf(view);
    // The top edge stays; the bottom edge moves right, all of it by as much.
    const bottomShift = g1.points[2]!.x - drawn.geometry.points[2]!.x;
    expect(bottomShift).toBeGreaterThan(30 / s);
    g1.points.forEach((p, i) => {
      const was = drawn.geometry.points[i]!;
      expect(p.y, `point ${i}: y`).toBeCloseTo(was.y, 1);
      const shift = was.y > 400 ? bottomShift : 0;
      expect(Math.abs(p.x - (was.x + shift)), `point ${i}: x`).toBeLessThanOrEqual(1.5);
    });

    await deselect(page);
    await expectEdgesPaintedAs(page, g1, 'sheared polygon');
  });

  test('Shift + the bottom handle shears a line, and its stored ends are the painted ones', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const drawn = await drawLine(page, view, { x: 560.2, y: 330.4 }, { x: 720.6, y: 430.8 });
    await shearFromBottom(page, view, drawn.id, { x: 640.4, y: 380.6 });

    const { skewX } = await storedData(page, ['skewX']);
    expect(typeof skewX === 'number' && skewX > 5, `skewX ${String(skewX)}`).toBe(true);
    const { geometry: g1 } = await readOnlyPoints(page);
    const s = scaleOf(view);
    const [start, end] = g1.points;
    expectClose(start!, drawn.geometry.points[0]!, 1.5, 'the upper end stays');
    expect(end!.x - drawn.geometry.points[1]!.x, 'the lower end moves right').toBeGreaterThan(
      30 / s,
    );
    expect(end!.y).toBeCloseTo(drawn.geometry.points[1]!.y, 1);

    await deselect(page);
    await expectEdgesPaintedAs(page, g1, 'sheared line');
  });
});

test.describe('Shape controls: the label of a sheared line or polygon', () => {
  const SHAPES = [
    {
      type: 'polygon',
      draw: (page: Page, view: View) =>
        drawPolygon(page, view, [
          { x: 560.2, y: 320.4 },
          { x: 720.6, y: 320.4 },
          { x: 720.6, y: 440.8 },
          { x: 560.2, y: 440.8 },
        ]),
      body: { x: 600, y: 400 },
    },
    {
      type: 'line',
      draw: (page: Page, view: View) =>
        drawLine(page, view, { x: 560.2, y: 330.4 }, { x: 720.6, y: 430.8 }),
      body: { x: 640.4, y: 380.6 },
    },
  ] as const;

  for (const shape of SHAPES) {
    test(`follows a Shift + side-handle shear of a ${shape.type} while it is dragged`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale: SCALE });
      const drawn = await shape.draw(page, view);
      await selectAt(page, onPixel(imageToPage(view, shape.body)), drawn.id);
      const label = page.locator(
        `[data-osdlabel="decoration-text"][data-decoration-id="measurement:${drawn.id}"]`,
      );
      await expect(label).toHaveCount(1);
      const start = await labelAt(page, drawn.id, shape.type);
      expectClose(
        start,
        expectedLabel(view, shape.type, drawn.geometry.points).at,
        1.5,
        'the label before the drag',
      );

      const stored = await annotationsText(page);
      const from = onPixel(await controlOnPage(page, 'mb'));
      await page.mouse.move(from.x, from.y);
      await page.keyboard.down('Shift');
      await page.mouse.down();
      try {
        await page.mouse.move(from.x + 60, from.y, { steps: 12 });

        // Mid-drag: Fabric paints a sheared shape, which state does not hold yet.
        const live = await paintedPointsOfSelection(page);
        const expected = expectedLabel(view, shape.type, live);
        expect(
          Math.hypot(expected.at.x - start.x, expected.at.y - start.y),
          'the shear moved the shape’s centre',
        ).toBeGreaterThan(15);
        expect(await annotationsText(page), 'nothing is committed mid-drag').toBe(stored);

        await expect
          .poll(
            async () => {
              const at = await labelAt(page, drawn.id, shape.type);
              return Math.hypot(at.x - expected.at.x, at.y - expected.at.y);
            },
            {
              message: `mid-drag, the label should sit at (${expected.at.x.toFixed(1)}, ${expected.at.y.toFixed(1)}), on the sheared ${shape.type}`,
              timeout: 3000,
            },
          )
          .toBeLessThanOrEqual(1.5);
        expect(await labelReading(page, drawn.id, expected.name)).toBeCloseTo(expected.value, 1);
      } finally {
        await page.mouse.up();
        await page.keyboard.up('Shift');
      }

      // The release commits the shear, and the label stays on it.
      await settle(page, stored);
      const { geometry: committed } = await readOnlyPoints(page);
      const after = expectedLabel(view, shape.type, committed.points);
      expectClose(await labelAt(page, drawn.id, shape.type), after.at, 1.5, 'the label after');
      expect(await labelReading(page, drawn.id, after.name)).toBeCloseTo(after.value, 1);
    });
  }
});

function expectClose(actual: Point, expected: Point, tol: number, what: string) {
  const d = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  expect(
    d,
    `${what}: (${actual.x}, ${actual.y}) vs (${expected.x}, ${expected.y})`,
  ).toBeLessThanOrEqual(tol);
}
