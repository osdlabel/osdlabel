/**
 * Clicks at one spot draw nothing with the polyline tool, however the path is
 * finished: a click and then a double click there, two clicks there and
 * Enter, three clicks there and `c`, or a fourth click there on the first
 * vertex. A path whose vertices all lie within `MIN_SHAPE_SCREEN_PX` (3
 * screen px) of one another is discarded when it is finished, as a
 * drag-to-draw shape under that size is on release (`shape-click.spec.ts`). A
 * small real polygon still draws. The free-hand tool draws nothing for a tap,
 * a scribble that stays in one spot, or a stroke the view zooms out under the
 * minimum before its release.
 *
 * Until this was fixed, each of those polyline paths committed an invisible
 * zero-length polyline or zero-area polygon. It painted nothing, yet it
 * carried decorations at the spot and counted toward the context's
 * `maxCount`: three clicks and Enter used up a third of Pneumothorax's
 * polylines.
 *
 * Paint is judged from Fabric's lower canvas, pixel by pixel, as the
 * rectangle suite does.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  annotationsText,
  openAnnotator,
  pageToImage,
  paintedBounds,
  readAnnotations,
  scaleOf,
  settle,
  storedStrokeWidth,
  waitForStableView,
  type Point,
  type View,
  type DevContext,
} from './rectangle/helpers.js';

/** Every annotation-anchored decoration: text labels and the dev app's DOM badges. */
const ANNOTATION_DECORATIONS =
  '[data-osdlabel="decoration-text"]:not([data-decoration-id="hud:ratio"]), [data-osdlabel-test="dom-badge"]';

/**
 * Longer than OSD's `dblClickTimeThreshold` (300 ms), the window in which the
 * overlay pairs two clicks within 20 px into a double click. Every click here
 * that is not half of a double click waits this long first, so that clicks at
 * one spot stay separate clicks, as a user's deliberate clicks would be.
 */
const CLICK_GAP_MS = 450;

/** A stored polyline or polygon, as `annotations-json` carries it. */
interface StoredPath {
  readonly geometry: { readonly type: string; readonly points?: readonly Point[] };
}

/**
 * A page point `dx`, `dy` CSS px from the centre of the canvas, on a whole
 * pixel. Every view these specs use shows image there.
 */
function spot(view: View, dx: number, dy: number): Point {
  return {
    x: Math.round(view.canvasOrigin.x + view.canvasSize.width / 2 + dx),
    y: Math.round(view.canvasOrigin.y + view.canvasSize.height / 2 + dy),
  };
}

function plus(p: Point, dx: number, dy: number): Point {
  return { x: p.x + dx, y: p.y + dy };
}

/** Allows 3 polylines and 3 free-hand paths per image. */
const PNEUMOTHORAX: DevContext = { index: 1, label: 'Pneumothorax' };

/** One click, after `CLICK_GAP_MS`, so that it cannot pair with the click before it. */
async function separateClick(page: Page, p: Point): Promise<void> {
  await page.waitForTimeout(CLICK_GAP_MS);
  await page.mouse.click(p.x, p.y);
}

/** Nothing is stored, painted on the canvas (a preview or vertex marker included), or decorated. */
async function expectNothingDrawn(page: Page, what: string): Promise<void> {
  await settle(page);
  expect(await readAnnotations(page), `${what}: stored`).toEqual([]);
  expect(await paintedBounds(page), `${what}: painted`).toBeNull();
  await expect(page.locator(ANNOTATION_DECORATIONS), `${what}: decorated`).toHaveCount(0);
}

/** The ways of finishing a polyline, each given every vertex at `at`. */
const ONE_SPOT_FINISHES: readonly {
  readonly name: string;
  readonly draw: (page: Page, at: Point) => Promise<void>;
}[] = [
  {
    name: 'a click, then a double click, at one spot',
    draw: async (page, at) => {
      await separateClick(page, at);
      await page.waitForTimeout(CLICK_GAP_MS);
      await page.mouse.dblclick(at.x, at.y);
    },
  },
  {
    name: 'two clicks at one spot, then Enter',
    draw: async (page, at) => {
      await separateClick(page, at);
      await separateClick(page, at);
      await page.keyboard.press('Enter');
    },
  },
  {
    name: "three clicks at one spot, then 'c'",
    draw: async (page, at) => {
      for (let i = 0; i < 3; i++) await separateClick(page, at);
      await page.keyboard.press('c');
    },
  },
  {
    name: 'three clicks at one spot, then a click on the first vertex',
    draw: async (page, at) => {
      for (let i = 0; i < 4; i++) await separateClick(page, at);
    },
  },
];

/**
 * The one stored annotation is a polygon through `clicks` (to within half a
 * screen px), decorated, and painted where it was clicked: the painted box is
 * the clicks' box, grown by up to a mitred stroke and 1.5 px of antialiasing.
 * A corner's mitre reaches at most Fabric's default miter limit, 4, times the
 * half stroke past the vertex.
 */
async function expectPolygonDrawn(
  page: Page,
  view: View,
  clicks: readonly Point[],
  what: string,
): Promise<void> {
  const all = (await readAnnotations(page)) as readonly StoredPath[];
  expect(all, `${what}: stored`).toHaveLength(1);
  const geometry = all[0]!.geometry;
  expect(geometry.type, `${what}: stored`).toBe('polygon');
  expect(geometry.points, `${what}: stored points`).toHaveLength(clicks.length);
  const tolerance = 0.5 / scaleOf(view);
  clicks.forEach((click, i) => {
    const expected = pageToImage(view, click);
    const stored = geometry.points![i]!;
    expect(
      Math.hypot(stored.x - expected.x, stored.y - expected.y),
      `${what}: vertex ${i} is stored at (${stored.x}, ${stored.y}), clicked at (${expected.x}, ${expected.y})`,
    ).toBeLessThanOrEqual(tolerance);
  });
  // So the empty count after the clicks at one spot means something: the
  // selector finds a drawn path's decorations.
  await expect(page.locator(ANNOTATION_DECORATIONS), `${what}: decorated`).not.toHaveCount(0);

  const grown = 4 * (((await storedStrokeWidth(page)) * scaleOf(view)) / 2) + 1.5;
  const xs = clicks.map((c) => c.x - view.canvasOrigin.x);
  const ys = clicks.map((c) => c.y - view.canvasOrigin.y);
  const expected = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
  const painted = await paintedBounds(page);
  expect(painted, `${what}: nothing is painted`).not.toBeNull();
  for (const side of ['minX', 'minY'] as const) {
    expect(painted![side], `${what}: painted ${side}`).toBeGreaterThanOrEqual(
      expected[side] - grown,
    );
    expect(painted![side], `${what}: painted ${side}`).toBeLessThanOrEqual(expected[side] + 1);
  }
  for (const side of ['maxX', 'maxY'] as const) {
    expect(painted![side], `${what}: painted ${side}`).toBeLessThanOrEqual(expected[side] + grown);
    expect(painted![side], `${what}: painted ${side}`).toBeGreaterThanOrEqual(expected[side] - 1);
  }
}

/** Click `points` as separate clicks and close the path with `c`, storing one polygon. */
async function drawPolygon(page: Page, points: readonly Point[]): Promise<void> {
  const before = await annotationsText(page);
  for (const p of points) await separateClick(page, p);
  await page.keyboard.press('c');
  await settle(page, before);
}

test.describe('Clicks at one spot draw no polyline', () => {
  for (const finish of ONE_SPOT_FINISHES) {
    test(`${finish.name} draws nothing and leaves Pneumothorax's quota untouched; a small polygon then uses it`, async ({
      page,
    }) => {
      // Pneumothorax allows 3 polylines.
      const view = await openAnnotator(page, { context: PNEUMOTHORAX });
      const polyline = page.getByTestId('tool-polyline');
      await expect(polyline).toContainText('Polyline 0/3');
      await polyline.click();

      await finish.draw(page, spot(view, -120, -80));
      await expectNothingDrawn(page, finish.name);
      await expect(polyline).toContainText('Polyline 0/3');
      await expect(polyline).toBeEnabled();

      // The tool is ready for a new path: a triangle 8 px across, clicked away
      // from the spot, is a polygon through its three clicks, and nothing else.
      const at = spot(view, 0, 60);
      const triangle = [at, plus(at, 8, 0), plus(at, 4, 7)];
      await drawPolygon(page, triangle);
      await expectPolygonDrawn(page, view, triangle, 'a triangle 8 px across');
      await expect(polyline).toContainText('Polyline 1/3');
    });
  }

  // The minimum is on screen, not in the image. Zoomed out to 0.5, clicks 2
  // px apart span 4 image px; zoomed in to 4.6, a 5 px triangle spans about
  // one. A minimum of 3 image px would keep the first and drop the second.
  for (const imageScale of [0.5, 4.6]) {
    test(`at ${imageScale} screen px per image px, clicks 2 px apart draw nothing; a 5 px triangle draws`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale });
      const polyline = page.getByTestId('tool-polyline');
      await expect(polyline).toContainText('Polyline 0');
      await polyline.click();

      const near = spot(view, -60, -40);
      await separateClick(page, near);
      await separateClick(page, plus(near, 2, 0));
      await separateClick(page, plus(near, 1, 2));
      await page.keyboard.press('Enter');
      await expectNothingDrawn(page, 'three clicks within 2 px, then Enter');

      const at = spot(view, 60, 40);
      const triangle = [at, plus(at, 5, 0), plus(at, 2, 4)];
      await drawPolygon(page, triangle);
      await expectPolygonDrawn(page, view, triangle, 'a triangle 5 px across');
      await expect(polyline).toContainText('Polyline 1');
    });
  }
});

test.describe('A free-hand stroke that stays in one spot draws nothing', () => {
  test("a tap or a scribble in one spot leaves Pneumothorax's quota untouched; a small stroke still uses it", async ({
    page,
  }) => {
    const view = await openAnnotator(page, { context: PNEUMOTHORAX });
    const freeHand = page.getByTestId('tool-freeHandPath');
    await expect(freeHand).toContainText('Free Draw 0/3');
    await freeHand.click();

    const tapAt = spot(view, -120, -80);
    await separateClick(page, tapAt);
    await expectNothingDrawn(page, 'a tap');

    // Round and round within 2 px of the press.
    const scribbleAt = spot(view, 0, -80);
    await page.waitForTimeout(CLICK_GAP_MS);
    await page.mouse.move(scribbleAt.x, scribbleAt.y);
    await page.mouse.down();
    for (const [dx, dy] of [
      [2, 0],
      [1, 2],
      [-1, 2],
      [-2, 0],
      [-1, -2],
      [1, -2],
      [2, 0],
    ] as const) {
      await page.mouse.move(scribbleAt.x + dx, scribbleAt.y + dy, { steps: 2 });
    }
    await page.mouse.up();
    await expectNothingDrawn(page, 'a scribble within 2 px of its press');
    await expect(freeHand).toContainText('Free Draw 0/3');
    await expect(freeHand).toBeEnabled();

    // A stroke round a 12 px triangle draws, and uses the quota.
    const at = spot(view, 0, 60);
    const before = await annotationsText(page);
    await page.waitForTimeout(CLICK_GAP_MS);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 12, at.y, { steps: 4 });
    await page.mouse.move(at.x + 6, at.y + 10, { steps: 4 });
    await page.mouse.up();
    await settle(page, before);
    const all = (await readAnnotations(page)) as readonly StoredPath[];
    expect(all, 'a 12 px stroke: stored').toHaveLength(1);
    expect(all[0]!.geometry.type, 'a 12 px stroke: stored').toBe('polygon');
    expect(await paintedBounds(page), 'a 12 px stroke: painted').not.toBeNull();
    await expect(freeHand).toContainText('Free Draw 1/3');
  });

  test('a stroke the view zooms out under 3 screen px before its release draws nothing', async ({
    page,
  }) => {
    // Zoomed in, a stroke round a 12 px triangle samples a vertex every few
    // px. Ctrl+wheel then zooms out about sevenfold with the button still
    // down, leaving the stroke under 2 px across when it is released, as
    // small as one that never left its spot.
    const view = await openAnnotator(page, { imageScale: 4.6, context: PNEUMOTHORAX });
    const freeHand = page.getByTestId('tool-freeHandPath');
    await expect(freeHand).toContainText('Free Draw 0/3');
    await freeHand.click();

    const at = spot(view, 0, 0);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 12, at.y, { steps: 4 });
    await page.mouse.move(at.x + 6, at.y + 10, { steps: 4 });
    expect(await paintedBounds(page), 'the stroke preview is painted').not.toBeNull();
    await page.keyboard.down('Control');
    for (let i = 0; i < 11; i++) await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    const zoomedOut = await waitForStableView(page);
    expect(scaleOf(zoomedOut), 'the wheel zoomed out').toBeLessThan(4.6 / 6);
    // So the empty result after the release means something: the stroke
    // reached the tool, and the zoom left it in progress, so it is the release
    // that discards it.
    expect(await paintedBounds(page), 'the zoom left the stroke in progress').not.toBeNull();
    await page.mouse.up();

    await expectNothingDrawn(page, 'a stroke zoomed out under 3 px before its release');
    await expect(freeHand).toContainText('Free Draw 0/3');
  });
});
