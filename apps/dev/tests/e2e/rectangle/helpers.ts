/**
 * Part of the rectangle suite: shared mechanics for the E2E rectangle specs in
 * this directory. The invariant every spec pins is that what is painted is
 * the stored geometry, `rectangleCorners(geometry)`, and that the stored
 * geometry is what the user did.
 *
 * Nothing here calls the library's rectangle code. The corners come from an
 * independent reference (`referenceCorners`, pinned to the worked example in
 * `rectangle-reference.spec.ts`); image space maps to the page through the
 * overlay's `viewportTransform`, the matrix Fabric paints with; and what is
 * painted is read back from Fabric's lower canvas, pixel by pixel.
 *
 * These helpers live beside the specs rather than in `../helpers/` because
 * they belong to this suite alone: a reference for the rectangle contract, a
 * pixel judge tuned to how a rectangle paints (a translucent fill inside a
 * stroke), and rectangle gestures. `../helpers/` holds what every spec in
 * `tests/e2e` shares, and this file builds on it: the binding-checking
 * `expect` from `fixtures.ts` and the selection probe from `selection.ts`.
 * Playwright collects only `*.spec.ts`, so this file is never run as a test.
 */
import type { Page } from '@playwright/test';
import { expect } from '../helpers/fixtures.js';
import { selectedAnnotationId } from '../helpers/selection.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The stored shape of a rectangle, as `annotations-json` carries it. */
export interface RectangleGeometry {
  readonly type: 'rectangle';
  readonly origin: Point;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface StoredAnnotation {
  readonly id: string;
  readonly geometry: { readonly type: string };
  readonly rawAnnotationData: {
    readonly format: string;
    readonly data: Record<string, unknown>;
  };
}

/** A stored rectangle: its id and geometry. */
export interface StoredRectangle {
  readonly id: string;
  readonly geometry: RectangleGeometry;
}

type ByImage = Record<string, Record<string, StoredAnnotation>>;

// ── Independent reference ────────────────────────────────────────────────

const DEG = Math.PI / 180;

/**
 * A point given in the rectangle's own frame, about its centre: the centre
 * `c = origin + (width/2, height/2)` plus `local` turned `rotation` degrees
 * clockwise (image y points down, so +90 takes +x onto +y).
 */
export function rectanglePoint(g: RectangleGeometry, local: Point): Point {
  const cx = g.origin.x + g.width / 2;
  const cy = g.origin.y + g.height / 2;
  const cos = Math.cos(g.rotation * DEG);
  const sin = Math.sin(g.rotation * DEG);
  return { x: cx + local.x * cos - local.y * sin, y: cy + local.x * sin + local.y * cos };
}

/** The four signs of a corner, in the order top-left, top-right, bottom-right, bottom-left. */
export const CORNER_SIGNS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
] as const;

/** Corners top-left, top-right, bottom-right, bottom-left of the unrotated box, turned about its centre. */
export function referenceCorners(g: RectangleGeometry): readonly Point[] {
  return CORNER_SIGNS.map((s) =>
    rectanglePoint(g, { x: (s.x * g.width) / 2, y: (s.y * g.height) / 2 }),
  );
}

export function referenceCentre(g: RectangleGeometry): Point {
  return rectanglePoint(g, { x: 0, y: 0 });
}

/** The axis-aligned box spanned by two drag points, as the geometry of an unrotated rectangle. */
export function boxFromDrag(a: Point, b: Point): RectangleGeometry {
  return {
    type: 'rectangle',
    origin: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
    rotation: 0,
  };
}

// ── View: image space <-> canvas <-> page ────────────────────────────────

export type Matrix = readonly [number, number, number, number, number, number];

/** The overlay's `viewportTransform`, and where its canvas sits on the page and how big it is. */
export interface View {
  readonly vpt: Matrix;
  readonly canvasOrigin: Point;
  readonly canvasSize: { readonly width: number; readonly height: number };
}

interface OverlayHandleShape {
  readonly canvas: {
    readonly viewportTransform: readonly number[];
    getElement(): HTMLCanvasElement;
    getActiveObject(): { id?: string; oCoords?: Record<string, Point> } | null | undefined;
    getObjects(): readonly { readonly strokeWidth: number }[];
  };
}

export async function readView(page: Page): Promise<View> {
  const raw = await page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const rect = overlay.canvas.getElement().getBoundingClientRect();
    return {
      vpt: [...overlay.canvas.viewportTransform],
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  });
  const [a, b, c, d, e, f] = raw.vpt;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined
  ) {
    throw new Error(`viewportTransform has ${raw.vpt.length} entries`);
  }
  return {
    vpt: [a, b, c, d, e, f],
    canvasOrigin: { x: raw.x, y: raw.y },
    canvasSize: { width: raw.width, height: raw.height },
  };
}

/** Screen px per image px. */
export function scaleOf(view: View): number {
  const [a, b] = view.vpt;
  return Math.hypot(a, b);
}

export function imageToCanvas(view: View, p: Point): Point {
  const [a, b, c, d, e, f] = view.vpt;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

export function canvasToImage(view: View, q: Point): Point {
  const [a, b, c, d, e, f] = view.vpt;
  const det = a * d - b * c;
  const x = q.x - e;
  const y = q.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}

export function imageToPage(view: View, p: Point): Point {
  const q = imageToCanvas(view, p);
  return { x: view.canvasOrigin.x + q.x, y: view.canvasOrigin.y + q.y };
}

export function pageToImage(view: View, p: Point): Point {
  return canvasToImage(view, { x: p.x - view.canvasOrigin.x, y: p.y - view.canvasOrigin.y });
}

/** A whole-pixel page position, so a mouse event lands exactly where the test computes it. */
export function onPixel(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// ── Opening the annotator ────────────────────────────────────────────────

/**
 * Open the dev app on its default image (landscape, 1280×800) under the
 * "General" context, which allows any number of rectangles. With
 * `imageScale`, zoom (about the viewport centre) to that many screen px per
 * image px; a view setting, not an edit.
 *
 * The context is chosen before the view is read or zoomed, and the view is
 * left to settle in between: General shows every tool, and the header can
 * wrap onto another line for it (it does at 1280 px wide, now that the
 * displayed-contexts panel lists five contexts). The viewer then moves and
 * resizes, which OSD answers a frame later by changing the zoom, so a view
 * read, or a zoom set, before that is stale.
 */
export async function openAnnotator(
  page: Page,
  options: { readonly imageScale?: number } = {},
): Promise<View> {
  await page.goto('/');
  await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 20000 });
  await page.selectOption('select', { index: 2 });
  await expect(page.getByTestId('status-context')).toContainText('General');
  await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdViewer?: { isOpen?: () => boolean }; __osdOverlay?: unknown })
        | null;
      return el?.__osdViewer?.isOpen?.() === true && el.__osdOverlay !== undefined;
    },
    undefined,
    { timeout: 20000 },
  );
  await waitForStableView(page);
  if (options.imageScale !== undefined) {
    await page.evaluate((scale) => {
      const el = document.querySelector('.openseadragon-canvas') as Element & {
        __osdViewer: {
          viewport: {
            imageToViewportZoom: (z: number) => number;
            zoomTo: (z: number, ref: undefined, immediately: boolean) => void;
          };
        };
      };
      const viewport = el.__osdViewer.viewport;
      viewport.zoomTo(viewport.imageToViewportZoom(scale), undefined, true);
    }, options.imageScale);
  }
  const view = await waitForStableView(page);
  if (options.imageScale !== undefined) {
    expect(scaleOf(view), 'the view did not reach the requested zoom').toBeCloseTo(
      options.imageScale,
      3,
    );
  }
  return view;
}

/** Wait until the overlay's transform stops changing, and return it. */
export async function waitForStableView(page: Page): Promise<View> {
  let previous = await readView(page);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    const next = await readView(page);
    if (
      next.vpt.every((v, k) => Math.abs(v - previous.vpt[k]!) < 1e-9) &&
      next.canvasOrigin.x === previous.canvasOrigin.x &&
      next.canvasOrigin.y === previous.canvasOrigin.y
    ) {
      return next;
    }
    previous = next;
  }
  throw new Error('the view never settled');
}

// ── Stored annotations ───────────────────────────────────────────────────

/**
 * The dev app's `annotations-json` readout, verbatim: every stored annotation,
 * by image. Captured before a gesture, it is what `settle` waits to change.
 */
export async function annotationsText(page: Page): Promise<string> {
  return (await page.getByTestId('annotations-json').textContent()) ?? '';
}

export async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const byImage = JSON.parse((await annotationsText(page)) || '{}') as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

function isRectangleGeometry(g: { readonly type: string }): g is RectangleGeometry {
  return g.type === 'rectangle';
}

/** The one stored annotation, which must be a rectangle. */
export async function readOnlyRectangle(page: Page): Promise<StoredRectangle> {
  const all = await readAnnotations(page);
  expect(all, 'expected exactly one stored annotation').toHaveLength(1);
  const only = all[0]!;
  const geometry = only.geometry;
  if (!isRectangleGeometry(geometry)) {
    throw new Error(`the stored annotation is a ${geometry.type}, not a rectangle`);
  }
  return { id: only.id, geometry };
}

/**
 * Assert two rectangle geometries agree to within `tol` image px and `rotTol`
 * degrees. Every edit rebuilds the object from its saved Fabric data, which
 * `toObject()` rounds to 4 decimals, so a value an edit leaves alone can still
 * differ from the one stored before it by up to 5e-5 relative.
 */
export function expectGeometryClose(
  actual: RectangleGeometry,
  expected: RectangleGeometry,
  tol: number,
  rotTol = 1e-3,
): void {
  const fields: [string, number, number, number][] = [
    ['origin.x', actual.origin.x, expected.origin.x, tol],
    ['origin.y', actual.origin.y, expected.origin.y, tol],
    ['width', actual.width, expected.width, tol],
    ['height', actual.height, expected.height, tol],
    ['rotation', actual.rotation, expected.rotation, rotTol],
  ];
  for (const [name, a, e, t] of fields) {
    expect(
      Math.abs(a - e),
      `${name}: stored ${a}, expected ${e} (±${t}); stored ${JSON.stringify(actual)}`,
    ).toBeLessThanOrEqual(t);
  }
}

export function expectPointClose(actual: Point, expected: Point, tol: number, what: string): void {
  const d = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  expect(
    d,
    `${what}: (${actual.x}, ${actual.y}) is ${d} from (${expected.x}, ${expected.y}), allowed ${tol}`,
  ).toBeLessThanOrEqual(tol);
}

/**
 * The stroke width, in image px, that the one stored annotation is painted
 * with: its saved Fabric `strokeWidth`. Its object is built with
 * `strokeUniform`, which keeps the stroke from scaling with the object's own
 * scale (a resize) but not with the view, so this is image px: the
 * `viewportTransform` scales it like the rest of the shape.
 */
export async function storedStrokeWidth(page: Page): Promise<number> {
  const all = await readAnnotations(page);
  expect(all, 'the stroke width is read from the one stored annotation').toHaveLength(1);
  const width = all[0]!.rawAnnotationData.data['strokeWidth'];
  if (typeof width !== 'number') {
    throw new Error(`the stored strokeWidth is ${JSON.stringify(width)}, not a number`);
  }
  return width;
}

/**
 * The stroke width, in image px, of the rectangle being drawn. Nothing is
 * stored until the drag ends, so it is read from the tool's preview, which
 * must be the only object on the canvas.
 */
export async function previewStrokeWidth(page: Page): Promise<number> {
  const widths = await page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    return overlay.canvas.getObjects().map((o) => o.strokeWidth);
  });
  expect(widths, 'the preview must be the only object on the canvas').toHaveLength(1);
  return widths[0]!;
}

// ── Pixels ───────────────────────────────────────────────────────────────

/**
 * RGBA of Fabric's lower canvas at canvas CSS px `points` (the pixel that
 * contains each point). The lower canvas holds the committed objects, an
 * in-progress preview, and, while something is selected, its controls; call
 * `deselect` before judging a shape by its pixels.
 */
export async function rgbaAt(page: Page, points: readonly Point[]): Promise<number[][]> {
  return page.evaluate((pts) => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const el = overlay.canvas.getElement();
    const ratio = el.width / el.clientWidth;
    const ctx = el.getContext('2d');
    if (!ctx) throw new Error('lower canvas has no 2d context');
    return pts.map((p) => {
      const x = Math.floor(p.x * ratio);
      const y = Math.floor(p.y * ratio);
      if (x < 0 || y < 0 || x >= el.width || y >= el.height) {
        throw new Error(`probe (${p.x}, ${p.y}) is off the canvas`);
      }
      return [...ctx.getImageData(x, y, 1, 1).data];
    });
  }, points);
}

export async function alphasAt(page: Page, points: readonly Point[]): Promise<number[]> {
  return (await rgbaAt(page, points)).map((rgba) => rgba[3]!);
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Alpha at or above which `paintedBounds` counts a pixel. Fabric paints a
 * scaled object from its cache canvas, whose resampling bleeds an alpha of a
 * few units one pixel past the antialiased edge; the default fill (alpha 26)
 * and any stroke coverage worth the name are well above it.
 */
export const PAINTED_ALPHA = 16;

/**
 * Alpha below which `expectPaintedAs`'s probes count a pixel as empty, and at
 * or above which as painted. The probes outside the shape sit 2.5 screen px
 * past the stroke's outer edge, beyond its antialiasing, and read 0 today.
 * Demanding exactly 0 would let a change in how Skia resamples a cached
 * object, whose faint residue reaches furthest along a 45° edge, fail
 * rotated specs whose rectangle is painted where it should be. The default
 * fill, alpha 26, is well above it, and a misplacement of 3 image px still
 * leaves a probe on the wrong side (see the pixel judge's own test in
 * `rectangle-drawing.spec.ts`).
 */
export const EMPTY_ALPHA = 4;

/**
 * How far, in canvas CSS px, each side of `paintedBounds` may sit from the
 * stored geometry's stroke outline. Pixels are whole, and an antialiased edge
 * covers part of the next one, so a bound can land a pixel past the outline
 * even when the shape is exact. A resized rectangle is painted from Fabric's
 * cache canvas, and some Chromium builds resample it with one more pixel above
 * PAINTED_ALPHA: CI's measured a bottom edge 1.63 px out after a corner resize
 * while another build measured under 1.5. The bounds catch paint away from the
 * shape (a duplicate, a wrong size); a misplaced shape is caught by the probes,
 * whose outside points sit the same 2.5 px past the outline.
 */
export const BOUNDS_TOLERANCE = 2.5;

/**
 * The box, in canvas CSS px, of every pixel on the lower canvas painted with
 * an alpha of at least `PAINTED_ALPHA`, or `null` if there is none. Pixel `i`
 * spans `[i, i + 1)`.
 */
export async function paintedBounds(page: Page): Promise<Bounds | null> {
  return page.evaluate((minAlpha) => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const el = overlay.canvas.getElement();
    const ratio = el.width / el.clientWidth;
    const ctx = el.getContext('2d');
    if (!ctx) throw new Error('lower canvas has no 2d context');
    const { data, width, height } = ctx.getImageData(0, 0, el.width, el.height);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3]! >= minAlpha) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minX === Infinity) return null;
    return {
      minX: minX / ratio,
      minY: minY / ratio,
      maxX: (maxX + 1) / ratio,
      maxY: (maxY + 1) / ratio,
    };
  }, PAINTED_ALPHA);
}

/** A cheap fingerprint of the lower canvas, to tell when painting has stopped. */
async function canvasFingerprint(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const el = overlay.canvas.getElement();
    const ctx = el.getContext('2d');
    if (!ctx) throw new Error('lower canvas has no 2d context');
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    let h = 0;
    for (let i = 3; i < data.length; i += 4)
      h = (h * 31 + data[i]! * ((i >> 2) % 9973)) % 2147483647;
    return h;
  });
}

/**
 * Wait until the stored annotations and the painted pixels both stop
 * changing. Every edit rebuilds the cell's Fabric objects from the stored
 * data, asynchronously, so a probe taken straight after an edit can see the
 * object mid-rebuild.
 *
 * With `changedFrom` (the `annotationsText` captured before a gesture), first
 * wait for the stored annotations to differ from it: a gesture that never
 * committed would otherwise settle at once, on the state before it, and
 * leave the failure to some later, less telling assertion.
 */
export async function settle(page: Page, changedFrom?: string): Promise<void> {
  if (changedFrom !== undefined) {
    await expect
      .poll(() => annotationsText(page), { message: 'the gesture never committed', timeout: 5000 })
      .not.toBe(changedFrom);
  }
  const read = async () => `${await annotationsText(page)}|${await canvasFingerprint(page)}`;
  let previous = await read();
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(100);
    const next = await read();
    stable = next === previous ? stable + 1 : 0;
    if (stable >= 2) return;
    previous = next;
  }
  throw new Error('the annotations or the canvas never settled');
}

// ── Selection and handles ────────────────────────────────────────────────

/** Leave annotation mode so nothing is selected, and wait for the repaint. */
export async function deselect(page: Page): Promise<void> {
  await page.getByTestId('tool-navigate').click();
  await expect.poll(() => selectedAnnotationId(page), { timeout: 5000 }).toBeNull();
  await settle(page);
}

/** Pick the select tool and click `pagePoint`; it must select the annotation `id`. */
export async function selectAt(page: Page, pagePoint: Point, id: string): Promise<void> {
  await page.getByTestId('tool-select').click();
  await page.mouse.click(pagePoint.x, pagePoint.y);
  await expect.poll(() => selectedAnnotationId(page), { timeout: 5000 }).toBe(id);
}

/** Fabric's control names: corners, edge midpoints, and the rotation handle. */
export type ControlName = 'tl' | 'tr' | 'br' | 'bl' | 'ml' | 'mt' | 'mr' | 'mb' | 'mtr';

/** Where the selected object's control `name` is drawn, in page px. */
export async function controlOnPage(page: Page, name: ControlName): Promise<Point> {
  const view = await readView(page);
  const at = await page.evaluate((key) => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const active = overlay.canvas.getActiveObject();
    const point = active?.oCoords?.[key];
    if (!point) throw new Error(`no active object, or it has no ${key} control`);
    return { x: point.x, y: point.y };
  }, name);
  return { x: view.canvasOrigin.x + at.x, y: view.canvasOrigin.y + at.y };
}

/** Press at `from`, move to `to` in `steps`, release; whole page pixels throughout. */
export async function drag(page: Page, from: Point, to: Point, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

// ── Paint vs geometry ────────────────────────────────────────────────────

/**
 * The painted shape is the stored rectangle `g`, judged by pixels:
 *
 * - just inside each corner, and just inside each edge's midpoint, is painted;
 * - just outside each corner, and each edge's midpoint, beyond the stroke and
 *   its antialiasing, is not;
 * - the box around every painted pixel is the box around the stroke's outer
 *   outline, `g` grown by half the stroke, to within antialiasing.
 *
 * "Painted" is an alpha of at least `EMPTY_ALPHA`, "not" an alpha below it.
 * The stroke is the one stored annotation's (`storedStrokeWidth`) unless
 * `options.strokeWidth` (image px) says otherwise, as it must for a preview,
 * which is not stored yet.
 *
 * Probes are placed with the independent reference, never the library.
 * Nothing may be selected (see `deselect`): selection controls paint too.
 */
export async function expectPaintedAs(
  page: Page,
  g: RectangleGeometry,
  what: string,
  options: { readonly strokeWidth?: number } = {},
): Promise<void> {
  const view = await readView(page);
  const s = scaleOf(view);
  const half = (options.strokeWidth ?? (await storedStrokeWidth(page))) / 2;
  // Inside: 2 screen px in from the edge, which lands on the stroke or the fill.
  const inset = 2 / s;
  // Outside: past the stroke's outer edge by 2.5 screen px of antialiasing.
  const outset = half + 2.5 / s;
  const hw = g.width / 2;
  const hh = g.height / 2;

  const probes: { name: string; local: Point; painted: boolean }[] = [];
  const cornerNames = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
  CORNER_SIGNS.forEach((sign, i) => {
    probes.push(
      {
        name: `inside the ${cornerNames[i]} corner`,
        local: { x: sign.x * (hw - inset), y: sign.y * (hh - inset) },
        painted: true,
      },
      {
        name: `outside the ${cornerNames[i]} corner`,
        local: { x: sign.x * (hw + outset), y: sign.y * (hh + outset) },
        painted: false,
      },
    );
  });
  const edges = [
    { name: 'top', n: { x: 0, y: -1 } },
    { name: 'right', n: { x: 1, y: 0 } },
    { name: 'bottom', n: { x: 0, y: 1 } },
    { name: 'left', n: { x: -1, y: 0 } },
  ] as const;
  for (const edge of edges) {
    probes.push(
      {
        name: `inside the ${edge.name} edge`,
        local: { x: edge.n.x * (hw - inset), y: edge.n.y * (hh - inset) },
        painted: true,
      },
      {
        name: `outside the ${edge.name} edge`,
        local: { x: edge.n.x * (hw + outset), y: edge.n.y * (hh + outset) },
        painted: false,
      },
    );
  }
  probes.push({ name: 'at the centre', local: { x: 0, y: 0 }, painted: true });

  const canvasPoints = probes.map((p) => imageToCanvas(view, rectanglePoint(g, p.local)));
  const alphas = await alphasAt(page, canvasPoints);
  probes.forEach((probe, i) => {
    const alpha = alphas[i]!;
    const at = canvasPoints[i]!;
    const message = `${what}: ${probe.name} of ${JSON.stringify(g)}, canvas (${at.x.toFixed(1)}, ${at.y.toFixed(1)})`;
    if (probe.painted) {
      expect(alpha, `${message} should be painted`).toBeGreaterThanOrEqual(EMPTY_ALPHA);
    } else {
      expect(alpha, `${message} should be empty`).toBeLessThan(EMPTY_ALPHA);
    }
  });

  // The stroke's outer outline, a mitred rectangle `half` beyond the box.
  const outline = CORNER_SIGNS.map((sign) =>
    imageToCanvas(view, rectanglePoint(g, { x: sign.x * (hw + half), y: sign.y * (hh + half) })),
  );
  const expected: Bounds = {
    minX: Math.min(...outline.map((p) => p.x)),
    minY: Math.min(...outline.map((p) => p.y)),
    maxX: Math.max(...outline.map((p) => p.x)),
    maxY: Math.max(...outline.map((p) => p.y)),
  };
  const painted = await paintedBounds(page);
  expect(painted, `${what}: nothing is painted`).not.toBeNull();
  for (const side of ['minX', 'minY', 'maxX', 'maxY'] as const) {
    expect(
      Math.abs(painted![side] - expected[side]),
      `${what}: painted ${side} ${painted![side]}, the stored geometry's outline ${expected[side]}`,
    ).toBeLessThanOrEqual(BOUNDS_TOLERANCE);
  }
}

// ── Gestures ─────────────────────────────────────────────────────────────

/**
 * Draw a rectangle with the rectangle tool, dragging from image point `a` to
 * image point `b` (snapped to whole page pixels), and return what was stored.
 */
export async function drawRectangle(
  page: Page,
  view: View,
  a: Point,
  b: Point,
): Promise<StoredRectangle> {
  await page.getByTestId('tool-rectangle').click();
  const before = await annotationsText(page);
  await drag(page, onPixel(imageToPage(view, a)), onPixel(imageToPage(view, b)), 6);
  await settle(page, before);
  return readOnlyRectangle(page);
}

/**
 * A page point on the rectangle's body, a quarter of the way from its centre
 * towards its bottom-right corner: clear of the handles, of the measurement
 * label at the centre and of the badge decoration above it.
 */
export function bodyPoint(view: View, g: RectangleGeometry): Point {
  return onPixel(imageToPage(view, rectanglePoint(g, { x: g.width / 4, y: g.height / 4 })));
}

/**
 * Turn the selected rectangle with its rotation handle: press the handle and
 * carry it `degrees` (clockwise on screen) around `centre`, the page point
 * the rectangle turns about, in steps of at most 5°. Returns what was stored.
 */
export async function rotateWithHandle(
  page: Page,
  centre: Point,
  degrees: number,
): Promise<StoredRectangle> {
  const before = await annotationsText(page);
  const handle = await controlOnPage(page, 'mtr');
  const dx = handle.x - centre.x;
  const dy = handle.y - centre.y;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  const steps = Math.max(6, Math.ceil(Math.abs(degrees) / 5));
  for (let k = 1; k <= steps; k++) {
    const t = ((degrees * k) / steps) * DEG;
    await page.mouse.move(
      centre.x + dx * Math.cos(t) - dy * Math.sin(t),
      centre.y + dx * Math.sin(t) + dy * Math.cos(t),
    );
  }
  await page.mouse.up();
  await settle(page, before);
  return readOnlyRectangle(page);
}

/**
 * Drag the selected rectangle by its body from page point `from` to `to`
 * (a point on the body, see `bodyPoint`), and return what was stored.
 */
export async function moveBody(
  page: Page,
  from: Point,
  to: Point,
  steps = 6,
): Promise<StoredRectangle> {
  const before = await annotationsText(page);
  await drag(page, from, to, steps);
  await settle(page, before);
  return readOnlyRectangle(page);
}

/**
 * Resize the selected rectangle: press its control `handle` and drag it to
 * `to(from)`, where `from` is the page point the handle is drawn at. Returns
 * what was stored.
 */
export async function resizeWithHandle(
  page: Page,
  handle: Exclude<ControlName, 'mtr'>,
  to: (from: Point) => Point,
  steps = 6,
): Promise<StoredRectangle> {
  const before = await annotationsText(page);
  const from = await controlOnPage(page, handle);
  await drag(page, from, to(from), steps);
  await settle(page, before);
  return readOnlyRectangle(page);
}

/**
 * Load `json` (an exported annotation list) through the dev app's Import JSON
 * panel, which replaces every stored annotation, and wait for it to land.
 */
export async function importAnnotations(page: Page, json: string): Promise<void> {
  const before = await annotationsText(page);
  await page.getByRole('button', { name: 'Import JSON' }).first().click();
  const input = page.getByPlaceholder('Paste exported JSON here...');
  await input.fill(json);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(input).toBeHidden();
  await settle(page, before);
}

/** The difference `a - b` between two angles in degrees, in (-180, 180]. */
export function angleBetween(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}
