/**
 * Editing several annotations at once with the select tool is saved, and
 * paints what it saves.
 *
 * A multi-selection is a Fabric `ActiveSelection`. Fabric reports a move,
 * scale or rotation of one with a single `object:modified` whose target is
 * the selection itself, which carries no annotation id, with the members
 * still inside it. Until this spec, nothing was committed for it: the canvas
 * painted the edited shapes while the stored geometry, exports and every
 * repaint from state kept the old ones. The specs pin, through the real input
 * routing and on both bindings:
 *
 * - moving, corner-scaling and rotating a drag-box selection of a rectangle,
 *   a circle, a point, a line and a polygon commits every member, with the
 *   geometry the edit gave it, in one commit;
 * - what is painted is what is stored (judged from canvas pixels for the
 *   rectangle and the circle), also after a rebuild from state (switching
 *   image and back) and after Export → Import;
 * - the selection survives the commit, on the rebuilt objects;
 * - a selection has no side handles, and its corners scale it uniformly
 *   even with Shift held, so a member can never be skewed or stretched;
 * - one gesture is one `object:modified` and one commit, a single shape too
 *   (Solid used to commit a single-shape drag twice);
 * - only the select tool selects by drag-box: a rectangle drawn across shapes
 *   leaves none of them selected;
 * - a Shift+click selection is the same uniform-only group, and does not
 *   name one of its members as the selected annotation;
 * - a point in a scaled selection moves with it but keeps its dot at its
 *   style's radius, judged from canvas pixels after the commit and after a
 *   rebuild: dissolving the selection bakes its scale into the dot, and the
 *   commit used to save that scale, so the dot grew or shrank with the group.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import { selectedAnnotationId } from './helpers/selection.js';
import {
  CORNER_SIGNS,
  EMPTY_ALPHA,
  PAINTED_ALPHA,
  alphasAt,
  annotationsText,
  controlOnPage,
  deselect,
  drag,
  imageToCanvas,
  imageToPage,
  onPixel,
  openAnnotator,
  readAnnotations,
  readView,
  rectanglePoint,
  scaleOf,
  settle,
  waitForStableView,
  type Bounds,
  type ControlName,
  type Point,
  type RectangleGeometry,
  type StoredAnnotation,
  type View,
} from './rectangle/helpers.js';

// ── Stored geometry ──────────────────────────────────────────────────────

interface CircleGeometry {
  readonly type: 'circle';
  readonly center: Point;
  readonly radius: number;
}
interface PointGeometry {
  readonly type: 'point';
  readonly position: Point;
}
interface LineGeometry {
  readonly type: 'line';
  readonly start: Point;
  readonly end: Point;
}
interface PolygonGeometry {
  readonly type: 'polygon';
  readonly points: readonly Point[];
}

/** The five shapes every group spec edits, as stored. */
interface Shapes {
  readonly rectangle: RectangleGeometry;
  readonly circle: CircleGeometry;
  readonly point: PointGeometry;
  readonly line: LineGeometry;
  readonly polygon: PolygonGeometry;
}

/** The ids of the five shapes, by geometry type. */
type ShapeIds = { readonly [K in keyof Shapes]: string };

function geometryOf(annotation: StoredAnnotation): unknown {
  return annotation.geometry;
}

async function readShapes(page: Page, ids: ShapeIds): Promise<Shapes> {
  const all = await readAnnotations(page);
  const byId = new Map(all.map((a) => [a.id, a]));
  const pick = <T>(id: string, type: string): T => {
    const found = byId.get(id);
    if (!found) throw new Error(`annotation ${id} (${type}) is not stored`);
    if (found.geometry.type !== type) {
      throw new Error(`annotation ${id} is a ${found.geometry.type}, not a ${type}`);
    }
    return geometryOf(found) as T;
  };
  return {
    rectangle: pick<RectangleGeometry>(ids.rectangle, 'rectangle'),
    circle: pick<CircleGeometry>(ids.circle, 'circle'),
    point: pick<PointGeometry>(ids.point, 'point'),
    line: pick<LineGeometry>(ids.line, 'line'),
    polygon: pick<PolygonGeometry>(ids.polygon, 'polygon'),
  };
}

/** The stored Fabric stroke width of annotation `id`, in image px. */
async function strokeWidthOf(page: Page, id: string): Promise<number> {
  const found = (await readAnnotations(page)).find((a) => a.id === id);
  const width = found?.rawAnnotationData.data['strokeWidth'];
  if (typeof width !== 'number') throw new Error(`annotation ${id} has no numeric strokeWidth`);
  return width;
}

function expectClose(actual: number, expected: number, tol: number, what: string): void {
  expect(
    Math.abs(actual - expected),
    `${what}: ${actual}, expected ${expected} (±${tol})`,
  ).toBeLessThanOrEqual(tol);
}

function expectPointNear(actual: Point, expected: Point, tol: number, what: string): void {
  const d = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  expect(
    d,
    `${what}: (${actual.x}, ${actual.y}) is ${d} from (${expected.x}, ${expected.y})`,
  ).toBeLessThanOrEqual(tol);
}

const add = (p: Point, d: Point): Point => ({ x: p.x + d.x, y: p.y + d.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Point): number => Math.hypot(v.x, v.y);
const angleOf = (v: Point): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;
const rectangleCentre = (g: RectangleGeometry): Point => rectanglePoint(g, { x: 0, y: 0 });

/** Every stored point of the five shapes, in a fixed order, for comparing two states. */
function landmarks(s: Shapes): Point[] {
  return [
    rectangleCentre(s.rectangle),
    s.circle.center,
    s.point.position,
    s.line.start,
    s.line.end,
    ...s.polygon.points,
  ];
}

// ── Fabric's selection, as the page sees it ──────────────────────────────

interface SelectionInfo {
  /** `none`, one annotation object, or a multi-selection (`ActiveSelection`). */
  readonly kind: 'none' | 'single' | 'group';
  /** The annotation ids of what is selected, sorted. */
  readonly ids: readonly string[];
  /** The selection's control names, sorted. */
  readonly controls: readonly string[];
  /** Whether every selected object is one the canvas currently holds. */
  readonly onCanvas: boolean;
}

interface FabricShape {
  readonly id?: string;
  readonly oCoords?: Record<string, Point>;
  getObjects?: () => FabricShape[];
}
interface CanvasShape {
  getActiveObject(): FabricShape | null | undefined;
  getObjects(): FabricShape[];
  on(event: string, cb: (e: { target: FabricShape & { type: string } }) => void): void;
}
type OverlayHost = Element & { __osdOverlay?: { canvas: CanvasShape } };

async function readSelection(page: Page): Promise<SelectionInfo> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as OverlayHost | null;
    const canvas = host?.__osdOverlay?.canvas;
    if (!canvas) throw new Error('overlay test hook not installed');
    const active = canvas.getActiveObject();
    if (!active) return { kind: 'none', ids: [], controls: [], onCanvas: true } as const;
    const isGroup = active.id === undefined && typeof active.getObjects === 'function';
    const members = isGroup ? active.getObjects!() : [active];
    const objects = canvas.getObjects();
    return {
      kind: isGroup ? 'group' : 'single',
      ids: members.map((m) => m.id ?? '').sort(),
      controls: Object.keys(active.oCoords ?? {}).sort(),
      onCanvas: members.every((m) => objects.includes(m)),
    } as const;
  });
}

/** Records every `object:modified` the canvas fires, from now on. */
async function recordModified(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as OverlayHost | null;
    const canvas = host?.__osdOverlay?.canvas;
    if (!canvas) throw new Error('overlay test hook not installed');
    const w = window as unknown as { __modified: string[] };
    w.__modified = [];
    canvas.on('object:modified', (e) => {
      w.__modified.push(e.target.id ?? e.target.type);
    });
  });
}

async function modifiedSoFar(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (window as unknown as { __modified: string[] }).__modified);
}

/**
 * Counts the dev app's commits: both apps log `Annotations changed:` from
 * their `onAnnotationsChange`, once per state change that reaches the host.
 */
function countCommits(page: Page): { readonly count: () => number; readonly reset: () => void } {
  let commits = 0;
  page.on('console', (message) => {
    if (message.text().startsWith('Annotations changed:')) commits += 1;
  });
  return {
    count: () => commits,
    reset: () => {
      commits = 0;
    },
  };
}

// ── Drawing ──────────────────────────────────────────────────────────────

const at = (view: View, p: Point): Point => onPixel(imageToPage(view, p));

async function drawShape(page: Page, gesture: () => Promise<void>): Promise<string> {
  const idsBefore = new Set((await readAnnotations(page)).map((a) => a.id));
  const before = await annotationsText(page);
  await gesture();
  await settle(page, before);
  const added = (await readAnnotations(page)).filter((a) => !idsBefore.has(a.id));
  expect(added, 'the gesture stored exactly one annotation').toHaveLength(1);
  return added[0]!.id;
}

/**
 * The five shapes, laid out left to right and top to bottom, far enough apart
 * that a probe outside one never lands on another, before or after the edits
 * the specs make. Image px on the landscape image (1280×800).
 */
const LAYOUT = {
  rectangle: { a: { x: 300, y: 250 }, b: { x: 420, y: 330 } },
  circle: { centre: { x: 540, y: 290 }, radius: 45 },
  point: { x: 650, y: 290 },
  line: { a: { x: 300, y: 420 }, b: { x: 440, y: 470 } },
  polygon: [
    { x: 520, y: 410 },
    { x: 620, y: 410 },
    { x: 610, y: 480 },
    { x: 530, y: 490 },
  ],
} as const;

async function drawShapes(page: Page, view: View): Promise<ShapeIds> {
  await page.getByTestId('tool-rectangle').click();
  const rectangle = await drawShape(page, () =>
    drag(page, at(view, LAYOUT.rectangle.a), at(view, LAYOUT.rectangle.b), 6),
  );
  await page.getByTestId('tool-circle').click();
  const circle = await drawShape(page, () =>
    drag(
      page,
      at(view, LAYOUT.circle.centre),
      at(view, add(LAYOUT.circle.centre, { x: LAYOUT.circle.radius, y: 0 })),
      6,
    ),
  );
  await page.getByTestId('tool-point').click();
  const point = await drawShape(page, async () => {
    const p = at(view, LAYOUT.point);
    await page.mouse.click(p.x, p.y);
  });
  await page.getByTestId('tool-line').click();
  const line = await drawShape(page, () =>
    drag(page, at(view, LAYOUT.line.a), at(view, LAYOUT.line.b), 6),
  );
  await page.getByTestId('tool-polyline').click();
  const polygon = await drawShape(page, async () => {
    for (const vertex of LAYOUT.polygon) {
      const p = at(view, vertex);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(150);
    }
    // Inside the 10 screen px close target around the first vertex.
    const first = at(view, LAYOUT.polygon[0]);
    await page.mouse.click(first.x + 2, first.y + 2);
  });
  return { rectangle, circle, point, line, polygon };
}

/** Drag-box from empty canvas over all five shapes, with the select tool. */
async function boxSelectAll(page: Page, view: View, ids: ShapeIds): Promise<void> {
  await page.getByTestId('tool-select').click();
  await drag(page, at(view, { x: 255, y: 205 }), at(view, { x: 720, y: 535 }), 10);
  const selection = await readSelection(page);
  expect(selection.kind, 'the drag-box made a multi-selection').toBe('group');
  expect(selection.ids).toEqual(Object.values(ids).sort());
}

/** Draw the five shapes and select them all with a drag-box. */
async function setUp(page: Page): Promise<{ view: View; ids: ShapeIds; before: Shapes }> {
  const view = await openAnnotator(page);
  const ids = await drawShapes(page, view);
  const before = await readShapes(page, ids);
  await boxSelectAll(page, view, ids);
  return { view, ids, before };
}

/** The handles a uniform-only selection keeps: its corners and its rotation handle. */
const GROUP_CONTROLS = ['bl', 'br', 'mtr', 'tl', 'tr'];

/** The same five annotations are selected as a group again, on the rebuilt objects. */
async function expectGroupSelected(page: Page, ids: ShapeIds, what: string): Promise<void> {
  await expect
    .poll(async () => (await readSelection(page)).kind, {
      message: `${what}: the selection did not survive the commit`,
      timeout: 5000,
    })
    .toBe('group');
  const selection = await readSelection(page);
  expect(selection.ids, `${what}: the selection holds other annotations`).toEqual(
    Object.values(ids).sort(),
  );
  expect(selection.onCanvas, `${what}: the selection holds objects no longer painted`).toBe(true);
  expect(selection.controls, `${what}: the selection has side handles`).toEqual(GROUP_CONTROLS);
}

/** Press the selection's control `name`, carry it to `to(from)`, release; returns where it started. */
async function dragControl(
  page: Page,
  name: ControlName,
  to: (from: Point) => Point,
  options: { readonly shift?: boolean } = {},
): Promise<void> {
  const from = onPixel(await controlOnPage(page, name));
  await page.mouse.move(from.x, from.y);
  await page.waitForTimeout(50);
  if (options.shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(to(from).x, to(from).y, { steps: 10 });
  await page.mouse.up();
  if (options.shift) await page.keyboard.up('Shift');
}

/** The page point the selection turns about: the middle of its box. */
async function selectionCentre(page: Page): Promise<Point> {
  const tl = await controlOnPage(page, 'tl');
  const br = await controlOnPage(page, 'br');
  return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
}

/** Carry the selection's rotation handle `degrees` clockwise around `centre`, in 5° steps. */
async function rotateSelection(page: Page, degrees: number): Promise<void> {
  const centre = await selectionCentre(page);
  const handle = await controlOnPage(page, 'mtr');
  const dx = handle.x - centre.x;
  const dy = handle.y - centre.y;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  const steps = Math.max(6, Math.ceil(Math.abs(degrees) / 5));
  for (let k = 1; k <= steps; k++) {
    const t = (((degrees * k) / steps) * Math.PI) / 180;
    await page.mouse.move(
      centre.x + dx * Math.cos(t) - dy * Math.sin(t),
      centre.y + dx * Math.sin(t) + dy * Math.cos(t),
    );
  }
  await page.mouse.up();
}

// ── Paint vs geometry ────────────────────────────────────────────────────

/**
 * The stored rectangle `g` is what is painted: just inside each corner and
 * edge midpoint is painted, just outside them (past the stroke and its
 * antialiasing) is not, and so is its centre. The rectangle suite's own judge
 * also compares the box around every painted pixel, which only works with one
 * shape on the canvas; here the other shapes are painted too.
 */
async function expectRectanglePainted(
  page: Page,
  g: RectangleGeometry,
  strokeWidth: number,
  what: string,
): Promise<void> {
  const view = await readView(page);
  const s = scaleOf(view);
  const inset = 2 / s;
  const outset = strokeWidth / 2 + 2.5 / s;
  const hw = g.width / 2;
  const hh = g.height / 2;
  const probes: { name: string; local: Point; painted: boolean }[] = [
    { name: 'the centre', local: { x: 0, y: 0 }, painted: true },
  ];
  CORNER_SIGNS.forEach((sign, i) => {
    probes.push(
      {
        name: `inside corner ${i}`,
        local: { x: sign.x * (hw - inset), y: sign.y * (hh - inset) },
        painted: true,
      },
      {
        name: `outside corner ${i}`,
        local: { x: sign.x * (hw + outset), y: sign.y * (hh + outset) },
        painted: false,
      },
    );
  });
  for (const n of [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ]) {
    probes.push(
      {
        name: `inside edge (${n.x}, ${n.y})`,
        local: { x: n.x * (hw - inset), y: n.y * (hh - inset) },
        painted: true,
      },
      {
        name: `outside edge (${n.x}, ${n.y})`,
        local: { x: n.x * (hw + outset), y: n.y * (hh + outset) },
        painted: false,
      },
    );
  }
  const points = probes.map((p) => imageToCanvas(view, rectanglePoint(g, p.local)));
  const alphas = await alphasAt(page, points);
  probes.forEach((probe, i) => {
    const message = `${what}: ${probe.name} of the stored rectangle ${JSON.stringify(g)}`;
    if (probe.painted) {
      expect(alphas[i]!, `${message} should be painted`).toBeGreaterThanOrEqual(EMPTY_ALPHA);
    } else {
      expect(alphas[i]!, `${message} should be empty`).toBeLessThan(EMPTY_ALPHA);
    }
  });
}

/**
 * The stored circle `c` is what is painted, round: at twelve angles, just
 * inside its outline is painted and just outside (past the stroke) is not, so
 * an ellipse or a circle of another radius or centre fails; and so is its
 * centre.
 */
async function expectCirclePainted(
  page: Page,
  c: CircleGeometry,
  strokeWidth: number,
  what: string,
): Promise<void> {
  const view = await readView(page);
  const s = scaleOf(view);
  const inside = c.radius - 2 / s;
  const outside = c.radius + strokeWidth / 2 + 2.5 / s;
  const probes: { name: string; at: Point; painted: boolean }[] = [
    { name: 'the centre', at: c.center, painted: true },
  ];
  for (let k = 0; k < 12; k++) {
    const t = (k * Math.PI) / 6;
    const u = { x: Math.cos(t), y: Math.sin(t) };
    probes.push(
      {
        name: `inside at ${k * 30}°`,
        at: add(c.center, { x: u.x * inside, y: u.y * inside }),
        painted: true,
      },
      {
        name: `outside at ${k * 30}°`,
        at: add(c.center, { x: u.x * outside, y: u.y * outside }),
        painted: false,
      },
    );
  }
  const alphas = await alphasAt(
    page,
    probes.map((p) => imageToCanvas(view, p.at)),
  );
  probes.forEach((probe, i) => {
    const message = `${what}: ${probe.name} of the stored circle ${JSON.stringify(c)}`;
    if (probe.painted) {
      expect(alphas[i]!, `${message} should be painted`).toBeGreaterThanOrEqual(EMPTY_ALPHA);
    } else {
      expect(alphas[i]!, `${message} should be empty`).toBeLessThan(EMPTY_ALPHA);
    }
  });
}

async function expectPaintedAsStored(page: Page, ids: ShapeIds, what: string): Promise<void> {
  const shapes = await readShapes(page, ids);
  await expectRectanglePainted(
    page,
    shapes.rectangle,
    await strokeWidthOf(page, ids.rectangle),
    `${what}, rectangle`,
  );
  await expectCirclePainted(
    page,
    shapes.circle,
    await strokeWidthOf(page, ids.circle),
    `${what}, circle`,
  );
}

/** Show another image in the cell and come back, so every object is rebuilt from state. */
async function rebuildFromState(page: Page): Promise<void> {
  const cell = page.locator('[data-annotation-count]').first();
  await page.getByTestId('filmstrip-item-portrait').click();
  await expect(cell).toHaveAttribute('data-annotation-count', '0');
  await page.getByTestId('filmstrip-item-landscape').click();
  await expect(cell).toHaveAttribute('data-annotation-count', '5');
  await waitForStableView(page);
  await settle(page);
}

/** The dev app draws points in the default style: `DEFAULT_POINT_RADIUS`, 5 image px. */
const DOT_RADIUS = 5;

/**
 * The box, in canvas CSS px, of every pixel within `reach` px of `at` (canvas
 * CSS px) that is painted with an alpha of at least `PAINTED_ALPHA`, or `null`
 * if there is none. Pixel `i` spans `[i, i + 1)`.
 */
async function paintedNear(page: Page, at: Point, reach: number): Promise<Bounds | null> {
  return page.evaluate(
    ({ at, reach, minAlpha }) => {
      const host = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdOverlay?: { canvas: { getElement(): HTMLCanvasElement } } })
        | null;
      const overlay = host?.__osdOverlay;
      if (!overlay) throw new Error('overlay test hook not installed');
      const el = overlay.canvas.getElement();
      const ratio = el.width / el.clientWidth;
      const ctx = el.getContext('2d');
      if (!ctx) throw new Error('lower canvas has no 2d context');
      const x0 = Math.max(0, Math.floor((at.x - reach) * ratio));
      const y0 = Math.max(0, Math.floor((at.y - reach) * ratio));
      const x1 = Math.min(el.width, Math.ceil((at.x + reach) * ratio));
      const y1 = Math.min(el.height, Math.ceil((at.y + reach) * ratio));
      const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const w = x1 - x0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3]! >= minAlpha) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      if (minX === Infinity) return null;
      return {
        minX: (x0 + minX) / ratio,
        minY: (y0 + minY) / ratio,
        maxX: (x0 + maxX + 1) / ratio,
        maxY: (y0 + maxY + 1) / ratio,
      };
    },
    { at, reach, minAlpha: PAINTED_ALPHA },
  );
}

/**
 * The stored point `id` is painted as a dot of `radius` image px, its style's,
 * about its stored position, and its saved Fabric data draws it so, unscaled
 * and unsheared. Judged from the pixels around it: the box of painted pixels
 * is the dot and its stroke, `radius + strokeWidth / 2` image px each way.
 */
async function expectDotPainted(page: Page, id: string, radius: number, what: string) {
  const found = (await readAnnotations(page)).find((a) => a.id === id);
  if (!found || found.geometry.type !== 'point') throw new Error(`${what}: no point ${id}`);
  const position = (geometryOf(found) as PointGeometry).position;

  const view = await readView(page);
  const s = scaleOf(view);
  const centre = imageToCanvas(view, position);
  const half = (radius + (await strokeWidthOf(page, id)) / 2) * s;
  const box = await paintedNear(page, centre, 3 * half + 4);
  expect(box, `${what}: nothing is painted at the point`).not.toBeNull();
  const painted = {
    centre: { x: (box!.minX + box!.maxX) / 2, y: (box!.minY + box!.maxY) / 2 },
    halfWidth: (box!.maxX - box!.minX) / 2,
    halfHeight: (box!.maxY - box!.minY) / 2,
  };
  const message = `${what}: the dot painted at ${JSON.stringify(painted)}, expected ${half.toFixed(2)} px about (${centre.x.toFixed(1)}, ${centre.y.toFixed(1)})`;
  expectPointNear(painted.centre, centre, 1, message);
  expectClose(painted.halfWidth, half, 1.25, message);
  expectClose(painted.halfHeight, half, 1.25, message);

  expect(found.rawAnnotationData.data, `${what}: the point's saved Fabric data`).toMatchObject({
    radius,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    skewY: 0,
  });
}

// ── Specs ────────────────────────────────────────────────────────────────

test.describe('Multi-selection edits', () => {
  test('moving a drag-box selection commits every member once and keeps the selection', async ({
    page,
  }) => {
    const commits = countCommits(page);
    const { view, ids, before } = await setUp(page);

    await recordModified(page);
    commits.reset();
    const stored = await annotationsText(page);
    const from = at(view, { x: 390, y: 310 }); // on the rectangle's body
    const to = { x: from.x + 57, y: from.y + 41 };
    await drag(page, from, to, 8);
    await settle(page, stored);

    const s = scaleOf(view);
    const d = { x: 57 / s, y: 41 / s };
    const after = await readShapes(page, ids);
    const was = landmarks(before);
    landmarks(after).forEach((p, i) => expectPointNear(p, add(was[i]!, d), 0.05, `landmark ${i}`));
    expectClose(after.rectangle.width, before.rectangle.width, 1e-3, 'rectangle width');
    expectClose(after.rectangle.height, before.rectangle.height, 1e-3, 'rectangle height');
    expectClose(after.rectangle.rotation, 0, 1e-3, 'rectangle rotation');
    expectClose(after.circle.radius, before.circle.radius, 1e-3, 'circle radius');

    // One gesture, one event, one commit.
    expect(await modifiedSoFar(page)).toHaveLength(1);
    expect(commits.count(), 'commits for one gesture').toBe(1);

    await expectGroupSelected(page, ids, 'after the move');

    await deselect(page);
    await expectPaintedAsStored(page, ids, 'after the move');

    // A rebuild from state paints the same shapes where they were moved to.
    await rebuildFromState(page);
    expect(await readShapes(page, ids)).toEqual(after);
    await deselect(page);
    await expectPaintedAsStored(page, ids, 'after switching image and back');
  });

  test('scaling a selection from a corner is uniform, even with Shift, and is saved', async ({
    page,
  }) => {
    const { ids, before } = await setUp(page);
    // A selection scales only from its corners: no side handles.
    expect((await readSelection(page)).controls).toEqual(GROUP_CONTROLS);

    const stored = await annotationsText(page);
    // Pulled much further right than down, with Shift held: a free corner
    // would stretch the selection, and Shift turns Fabric's uniform scaling off.
    await dragControl(page, 'br', (p) => ({ x: p.x + 70, y: p.y + 12 }), { shift: true });
    await settle(page, stored);

    const after = await readShapes(page, ids);
    const k = after.rectangle.width / before.rectangle.width;
    expect(k, 'the selection grew').toBeGreaterThan(1.05);
    // Every member scaled by the same factor, in both directions.
    expectClose(after.rectangle.height / before.rectangle.height, k, 1e-3, 'rectangle height');
    expectClose(after.circle.radius / before.circle.radius, k, 1e-3, 'circle radius');
    expectClose(
      len(sub(after.line.end, after.line.start)) / len(sub(before.line.end, before.line.start)),
      k,
      1e-3,
      'line length',
    );
    // And so did the distances between them: nothing was stretched.
    expectClose(
      len(sub(after.point.position, after.circle.center)) /
        len(sub(before.point.position, before.circle.center)),
      k,
      1e-3,
      'circle to point',
    );
    expectClose(
      len(sub(after.polygon.points[0]!, rectangleCentre(after.rectangle))) /
        len(sub(before.polygon.points[0]!, rectangleCentre(before.rectangle))),
      k,
      1e-3,
      'rectangle to polygon',
    );
    expectClose(after.rectangle.rotation, 0, 1e-3, 'rectangle rotation');

    await expectGroupSelected(page, ids, 'after scaling');

    await deselect(page);
    await expectPaintedAsStored(page, ids, 'after scaling');

    // Export carries the edit; importing it into a fresh annotator paints it.
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const exportPanel = page.locator('textarea');
    await expect(exportPanel).toHaveCount(1);
    const exported = await exportPanel.inputValue();
    const exportedById = new Map(
      (JSON.parse(exported) as { id: string; geometry: unknown }[]).map((a) => [a.id, a.geometry]),
    );
    expect(exportedById.get(ids.rectangle)).toEqual(after.rectangle);
    expect(exportedById.get(ids.circle)).toEqual(after.circle);
    expect(exportedById.get(ids.polygon)).toEqual(after.polygon);

    await openAnnotator(page);
    const empty = await annotationsText(page);
    await page.getByRole('button', { name: 'Import JSON' }).first().click();
    const input = page.getByPlaceholder('Paste exported JSON here...');
    await input.fill(exported);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(input).toBeHidden();
    await settle(page, empty);
    expect(await readShapes(page, ids)).toEqual(after);
    await expectPaintedAsStored(page, ids, 'after Export → Import');
  });

  test('rotating a selection turns every member about its centre, and is saved', async ({
    page,
  }) => {
    const { ids, before } = await setUp(page);

    const stored = await annotationsText(page);
    await rotateSelection(page, 30);
    await settle(page, stored);

    const after = await readShapes(page, ids);
    // Fabric snaps nothing by default; the handle lands within a degree.
    expectClose(after.rectangle.rotation, 30, 1, 'rectangle rotation');
    const turn = after.rectangle.rotation;
    expectClose(after.rectangle.width, before.rectangle.width, 1e-3, 'rectangle width');
    expectClose(after.rectangle.height, before.rectangle.height, 1e-3, 'rectangle height');
    expectClose(after.circle.radius, before.circle.radius, 1e-3, 'circle radius');
    const v0 = sub(before.point.position, before.circle.center);
    const v1 = sub(after.point.position, after.circle.center);
    expectClose(len(v1), len(v0), 1e-3, 'circle to point distance');
    expectClose(angleOf(v1) - angleOf(v0), turn, 1e-3, 'circle to point direction');
    expectClose(
      len(sub(after.line.end, after.line.start)),
      len(sub(before.line.end, before.line.start)),
      1e-3,
      'line length',
    );

    await expectGroupSelected(page, ids, 'after rotating');

    await deselect(page);
    await expectPaintedAsStored(page, ids, 'after rotating');
    await rebuildFromState(page);
    expect(await readShapes(page, ids)).toEqual(after);
    await deselect(page);
    await expectPaintedAsStored(page, ids, 'after rotating, switching image and back');
  });

  test('dragging one shape fires object:modified once and commits once', async ({ page }) => {
    const commits = countCommits(page);
    const view = await openAnnotator(page);
    await page.getByTestId('tool-rectangle').click();
    const id = await drawShape(page, () =>
      drag(page, at(view, LAYOUT.rectangle.a), at(view, LAYOUT.rectangle.b), 6),
    );
    await page.getByTestId('tool-select').click();
    const body = at(view, { x: 390, y: 310 });
    await page.mouse.click(body.x, body.y);
    await expect.poll(() => selectedAnnotationId(page)).toBe(id);

    await recordModified(page);
    commits.reset();
    const stored = await annotationsText(page);
    await drag(page, body, { x: body.x + 40, y: body.y + 25 }, 8);
    await settle(page, stored);

    expect(await modifiedSoFar(page)).toEqual([id]);
    expect(commits.count(), 'commits for one drag').toBe(1);
  });

  test('a rectangle drawn across shapes leaves none of them selected', async ({ page }) => {
    const view = await openAnnotator(page);
    const ids = await drawShapes(page, view);

    // With the rectangle tool, from empty canvas across the rectangle and the circle.
    await page.getByTestId('tool-rectangle').click();
    const drawn = await drawShape(page, () =>
      drag(page, at(view, { x: 270, y: 220 }), at(view, { x: 600, y: 360 }), 10),
    );
    expect(Object.values(ids)).not.toContain(drawn);

    expect(await readSelection(page)).toEqual({
      kind: 'none',
      ids: [],
      controls: [],
      onCanvas: true,
    });
  });

  test('Shift+click builds the same uniform-only selection, which names no single annotation', async ({
    page,
  }) => {
    const view = await openAnnotator(page);
    const ids = await drawShapes(page, view);
    const before = await readShapes(page, ids);

    await page.getByTestId('tool-select').click();
    const rectangleBody = at(view, { x: 390, y: 310 });
    await page.mouse.click(rectangleBody.x, rectangleBody.y);
    await expect.poll(() => selectedAnnotationId(page)).toBe(ids.rectangle);
    // The circle, below its centre (clear of its labels and badge).
    const circleBody = at(view, add(LAYOUT.circle.centre, { x: 0, y: 25 }));
    await page.keyboard.down('Shift');
    await page.mouse.click(circleBody.x, circleBody.y);
    await page.keyboard.up('Shift');

    const selection = await readSelection(page);
    expect(selection.kind).toBe('group');
    expect(selection.ids).toEqual([ids.rectangle, ids.circle].sort());
    expect(selection.controls).toEqual(GROUP_CONTROLS);
    // Two annotations are selected, so neither is "the" selected annotation:
    // the circle-only convert button must not offer to convert the group's circle.
    await expect(page.getByTestId('convert-to-rect')).toHaveCount(0);

    const stored = await annotationsText(page);
    await drag(page, rectangleBody, { x: rectangleBody.x - 30, y: rectangleBody.y + 45 }, 8);
    await settle(page, stored);
    const s = scaleOf(view);
    const d = { x: -30 / s, y: 45 / s };
    const after = await readShapes(page, ids);
    expectPointNear(
      rectangleCentre(after.rectangle),
      add(rectangleCentre(before.rectangle), d),
      0.05,
      'rectangle',
    );
    expectPointNear(after.circle.center, add(before.circle.center, d), 0.05, 'circle');
    // The rest were not in the selection.
    expect(after.point).toEqual(before.point);
    expect(after.line).toEqual(before.line);
    expect(after.polygon).toEqual(before.polygon);
  });

  test("scaling a selection keeps a point's dot at its style's radius, after the commit and after a rebuild", async ({
    page,
  }) => {
    const view = await openAnnotator(page);
    const ids = await drawShapes(page, view);
    await deselect(page);
    // The judge's premise: the dot as drawn, in the dev app's default style.
    await expectDotPainted(page, ids.point, DOT_RADIUS, 'as drawn');

    const before = await readShapes(page, ids);
    await boxSelectAll(page, view, ids);
    const stored = await annotationsText(page);
    // The bottom-right corner carried to twice its distance from the top-left
    // one: the selection, and every member in it, doubles.
    const tl = await controlOnPage(page, 'tl');
    await dragControl(page, 'br', (br) => ({
      x: tl.x + 2 * (br.x - tl.x),
      y: tl.y + 2 * (br.y - tl.y),
    }));
    await settle(page, stored);

    const after = await readShapes(page, ids);
    const k = after.rectangle.width / before.rectangle.width;
    expect(k, 'the selection was scaled').toBeGreaterThan(1.8);
    // The point went where the selection took it…
    expectClose(
      len(sub(after.point.position, after.circle.center)) /
        len(sub(before.point.position, before.circle.center)),
      k,
      1e-3,
      'circle to point',
    );
    // …and its dot is the size it was.
    await deselect(page);
    await expectDotPainted(page, ids.point, DOT_RADIUS, 'after the commit');

    await rebuildFromState(page);
    expect(await readShapes(page, ids)).toEqual(after);
    await deselect(page);
    await expectDotPainted(page, ids.point, DOT_RADIUS, 'after switching image and back');
  });
});
