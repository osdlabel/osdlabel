/**
 * Part of the rectangle suite. Pins that the decorations the dev app shows for
 * a rectangle sit on the rectangle: the measurement label (centred on its
 * centroid) is centred on the stored geometry's centre, and the badge
 * (anchored 28 px above the centroid) is centred above it, whether the
 * rectangle is rotated, moved, or seen in a rotated or flipped view. The
 * paint is judged against the same geometry, so the decorations sit on the
 * rectangle as painted. The label's area and perimeter are the stored box's,
 * w·h px² and 2(w + h) px, whatever its rotation.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures.js';
import {
  angleBetween,
  bodyPoint,
  deselect,
  drawRectangle,
  expectGeometryClose,
  expectPaintedAs,
  expectPointClose,
  imageToPage,
  moveBody,
  openAnnotator,
  pageToImage,
  paintedBounds,
  referenceCentre,
  rotateWithHandle,
  selectAt,
  settle,
  waitForStableView,
  type Point,
  type RectangleGeometry,
  type StoredRectangle,
  type View,
} from './helpers.js';

const A: Point = { x: 480.3, y: 290.6 };
const B: Point = { x: 690.8, y: 420.1 };

/** The centre of everything painted on the lower canvas, in page px. */
async function paintedCentre(page: Page, view: View): Promise<Point> {
  const box = await paintedBounds(page);
  expect(box, 'nothing is painted').not.toBeNull();
  return {
    x: view.canvasOrigin.x + (box!.minX + box!.maxX) / 2,
    y: view.canvasOrigin.y + (box!.minY + box!.maxY) / 2,
  };
}

/** Select the drawn rectangle and turn it `degrees` with its handle; the rotation must take. */
async function rotate(
  page: Page,
  view: View,
  drawn: StoredRectangle,
  degrees: number,
): Promise<StoredRectangle> {
  await selectAt(page, bodyPoint(view, drawn.geometry), drawn.id);
  const rotated = await rotateWithHandle(
    page,
    imageToPage(view, referenceCentre(drawn.geometry)),
    degrees,
  );
  expect(
    Math.abs(angleBetween(rotated.geometry.rotation, degrees)),
    `turned ${degrees}° with the handle, stored ${rotated.geometry.rotation}°`,
  ).toBeLessThanOrEqual(1);
  return rotated;
}

/**
 * Assert `g` is what is painted, the label and badge of `id` sit on `g`'s
 * centre, and the label reads `g`'s measurements.
 */
async function expectDecorationsOnShape(
  page: Page,
  view: View,
  id: string,
  g: RectangleGeometry,
  what: string,
): Promise<void> {
  await expectPaintedAs(page, g, what);
  // Where the label and badge must be: the stored geometry's centre, from the
  // independent reference. `expectPaintedAs` has just pinned the paint to the
  // same geometry.
  const centre = imageToPage(view, referenceCentre(g));
  // A loose sanity check of that premise, from the paint alone.
  expectPointClose(await paintedCentre(page, view), centre, 1.5, `${what}: painted centre`);

  const label = page.locator(
    `[data-osdlabel="decoration-text"][data-decoration-id="measurement:${id}"]`,
  );
  await expect(label).toHaveCount(1);
  const labelBox = await label.boundingBox();
  expect(labelBox, `${what}: the measurement label is not laid out`).not.toBeNull();
  expectPointClose(
    { x: labelBox!.x + labelBox!.width / 2, y: labelBox!.y + labelBox!.height / 2 },
    centre,
    1.5,
    `${what}: measurement label centre`,
  );

  const badge = page.locator(`[data-osdlabel="decoration-dom"][data-decoration-id="badge:${id}"]`);
  await expect(badge).toHaveCount(1);
  const badgeBox = await badge.boundingBox();
  expect(badgeBox, `${what}: the badge is not laid out`).not.toBeNull();
  expectPointClose(
    { x: badgeBox!.x + badgeBox!.width / 2, y: badgeBox!.y + badgeBox!.height },
    { x: centre.x, y: centre.y - 28 },
    1.5,
    `${what}: badge bottom centre`,
  );

  // One measurement per line, "A: 27407.96 px²" then "P: 681.75 px".
  const text = (await label.textContent()) ?? '';
  const read = (name: string, unit: string): number => {
    const match = new RegExp(`^${name}: ([\\d,.]+) ${unit}$`, 'm').exec(text);
    expect(match, `${what}: the label "${text}" has no ${name} in ${unit}`).not.toBeNull();
    return Number(match![1]!.replace(/,/g, ''));
  };
  expect(read('A', 'px²')).toBeCloseTo(g.width * g.height, 1);
  expect(read('P', 'px')).toBeCloseTo(2 * (g.width + g.height), 1);
}

test.describe('Rectangle suite: decorations on the painted rectangle', () => {
  test('unrotated, rotated and moved, the label and badge follow the rectangle', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 1.37 });
    const drawn = await drawRectangle(page, view, A, B);
    await deselect(page);
    await expectDecorationsOnShape(page, view, drawn.id, drawn.geometry, 'unrotated');

    const rotated = await rotate(page, view, drawn, 40);
    await deselect(page);
    await expectDecorationsOnShape(page, view, drawn.id, rotated.geometry, 'rotated');

    const start = bodyPoint(view, rotated.geometry);
    const end = { x: start.x - 61, y: start.y + 47 };
    await selectAt(page, start, drawn.id);
    const moved = await moveBody(page, start, end);
    // The move took, and moved the rectangle by the drag and nothing else.
    const g = rotated.geometry;
    expectGeometryClose(
      moved.geometry,
      {
        ...g,
        origin: {
          x: g.origin.x + pageToImage(view, end).x - pageToImage(view, start).x,
          y: g.origin.y + pageToImage(view, end).y - pageToImage(view, start).y,
        },
      },
      0.05,
    );
    await deselect(page);
    await expectDecorationsOnShape(page, view, drawn.id, moved.geometry, 'rotated and moved');
  });

  for (const v of [
    { name: 'a horizontally flipped view', clicks: ['view-flip-h'] },
    { name: 'a view rotated 90° clockwise', clicks: ['view-rotate-cw'] },
    { name: 'a vertically flipped view', clicks: ['view-flip-v'] },
  ] as const) {
    test(`in ${v.name}, the label and badge of a rotated rectangle sit on its centre`, async ({
      page,
    }) => {
      const upright = await openAnnotator(page, { imageScale: 1.37 });
      const drawn = await drawRectangle(page, upright, A, B);
      const rotated = await rotate(page, upright, drawn, 25);
      await deselect(page);

      for (const testId of v.clicks) await page.getByTestId(testId).click();
      const view = await waitForStableView(page);
      await settle(page);
      await expectDecorationsOnShape(page, view, drawn.id, rotated.geometry, `in ${v.name}`);
    });
  }
});
