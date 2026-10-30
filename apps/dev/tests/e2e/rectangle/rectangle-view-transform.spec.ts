/**
 * Part of the rectangle suite. Pins that a rectangle drawn or edited while
 * the cell view is rotated or flipped (the view controls) is stored in image
 * space, as the image-space box the user dragged, and paints as its stored
 * geometry both in that view and once the view is reset; and that while it
 * is being drawn in a rotated view, the preview already covers the
 * image-space box under the drag.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures.js';
import {
  angleBetween,
  annotationsText,
  bodyPoint,
  boxFromDrag,
  deselect,
  drag,
  expectGeometryClose,
  expectPaintedAs,
  expectPointClose,
  imageToPage,
  onPixel,
  openAnnotator,
  pageToImage,
  previewStrokeWidth,
  readAnnotations,
  readOnlyRectangle,
  referenceCentre,
  referenceCorners,
  resizeWithHandle,
  rotateWithHandle,
  scaleOf,
  selectAt,
  settle,
  waitForStableView,
  type Point,
  type RectangleGeometry,
  type View,
} from './helpers.js';

const VIEWS = [
  { name: 'rotated 90° clockwise', clicks: ['view-rotate-cw'], rotated: true, mirrored: false },
  {
    name: 'rotated 90° anticlockwise',
    clicks: ['view-rotate-ccw'],
    rotated: true,
    mirrored: false,
  },
  { name: 'flipped horizontally', clicks: ['view-flip-h'], rotated: false, mirrored: true },
  { name: 'flipped vertically', clicks: ['view-flip-v'], rotated: false, mirrored: true },
  {
    name: 'rotated 90° and flipped horizontally',
    clicks: ['view-rotate-cw', 'view-flip-h'],
    rotated: true,
    mirrored: true,
  },
] as const;

/** Apply the view controls, then check the overlay's transform is the one they name. */
async function transformView(
  page: Page,
  clicks: readonly string[],
  rotated: boolean,
  mirrored: boolean,
): Promise<View> {
  for (const testId of clicks) await page.getByTestId(testId).click();
  const view = await waitForStableView(page);
  const [a, b, c, d] = view.vpt;
  // A quarter turn puts the image's x axis on the screen's y axis…
  if (rotated) expect(Math.abs(a)).toBeLessThan(1e-9);
  else expect(Math.abs(b)).toBeLessThan(1e-9);
  // …and a mirror reverses the handedness.
  expect(Math.sign(a * d - b * c)).toBe(mirrored ? -1 : 1);
  return view;
}

/** Reset the view and check it is upright and unmirrored again. */
async function resetView(page: Page): Promise<View> {
  await page.getByTestId('view-reset').click();
  const view = await waitForStableView(page);
  expect(view.vpt[0]).toBeGreaterThan(0);
  expect(Math.abs(view.vpt[1])).toBeLessThan(1e-9);
  expect(view.vpt[3]).toBeGreaterThan(0);
  return view;
}

/** The page points of a drag about the middle of the canvas, from upper left to lower right. */
function dragAcrossTheMiddle(view: View): { readonly from: Point; readonly to: Point } {
  const mid = {
    x: view.canvasOrigin.x + view.canvasSize.width / 2,
    y: view.canvasOrigin.y + view.canvasSize.height / 2,
  };
  return {
    from: onPixel({ x: mid.x - 130, y: mid.y - 70 }),
    to: onPixel({ x: mid.x + 90, y: mid.y + 95 }),
  };
}

/** Drag a rectangle about the middle of the canvas; return the image-space box dragged. */
async function drawAcrossTheMiddle(page: Page, view: View): Promise<RectangleGeometry> {
  const { from, to } = dragAcrossTheMiddle(view);
  await page.getByTestId('tool-rectangle').click();
  const before = await annotationsText(page);
  await drag(page, from, to, 6);
  await settle(page, before);
  return boxFromDrag(pageToImage(view, from), pageToImage(view, to));
}

test.describe('Rectangle suite: rotated and flipped views', () => {
  test('mid-drag in a view rotated 90° clockwise, the preview covers the image-space box under the drag', async ({
    page,
  }) => {
    await openAnnotator(page, { imageScale: 1.37 });
    const view = await transformView(page, ['view-rotate-cw'], true, false);
    const { from, to } = dragAcrossTheMiddle(view);
    const dragged = boxFromDrag(pageToImage(view, from), pageToImage(view, to));

    await page.getByTestId('tool-rectangle').click();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    // Still held: nothing is stored, and the preview is painted over the box.
    await settle(page);
    expect(await readAnnotations(page)).toEqual([]);
    await expectPaintedAs(page, dragged, 'the preview in the rotated view', {
      strokeWidth: await previewStrokeWidth(page),
    });
    await page.mouse.up();
  });

  for (const v of VIEWS) {
    test(`drawn in a view ${v.name}, it stores the image-space box and paints it`, async ({
      page,
    }) => {
      await openAnnotator(page, { imageScale: 1.37 });
      const view = await transformView(page, v.clicks, v.rotated, v.mirrored);

      const dragged = await drawAcrossTheMiddle(page, view);
      const { geometry } = await readOnlyRectangle(page);
      expectGeometryClose(geometry, dragged, 0.5 / scaleOf(view));
      await expectPaintedAs(page, geometry, `in the view ${v.name}`);

      await resetView(page);
      expect((await readOnlyRectangle(page)).geometry).toEqual(geometry);
      await expectPaintedAs(page, geometry, 'after resetting the view');
    });
  }

  test('rotated with its handle in a flipped view, it turns the mirrored way and paints as stored', async ({
    page,
  }) => {
    await openAnnotator(page, { imageScale: 1.37 });
    const view = await transformView(page, ['view-flip-h'], false, true);
    await drawAcrossTheMiddle(page, view);
    const before = await readOnlyRectangle(page);

    await selectAt(page, bodyPoint(view, before.geometry), before.id);
    // 30° clockwise on a mirrored screen is 30° anticlockwise in the image.
    const after = await rotateWithHandle(
      page,
      imageToPage(view, referenceCentre(before.geometry)),
      30,
    );

    expectGeometryClose(
      { ...after.geometry, rotation: 0 },
      { ...before.geometry, rotation: 0 },
      0.5,
    );
    expectPointClose(
      referenceCentre(after.geometry),
      referenceCentre(before.geometry),
      0.5,
      'the centre',
    );
    expect(Math.abs(angleBetween(after.geometry.rotation, -30))).toBeLessThanOrEqual(1);

    await deselect(page);
    await expectPaintedAs(page, after.geometry, 'rotated in the flipped view');
    await resetView(page);
    await expectPaintedAs(page, after.geometry, 'after resetting the view');
  });

  test('resized from a side handle in a rotated view, its opposite side stays and it paints as stored', async ({
    page,
  }) => {
    await openAnnotator(page, { imageScale: 1.37 });
    const view = await transformView(page, ['view-rotate-cw'], true, false);
    await drawAcrossTheMiddle(page, view);
    const before = await readOnlyRectangle(page);
    const g0 = before.geometry;

    await selectAt(page, bodyPoint(view, g0), before.id);
    // The image's right side, which this view shows at the bottom.
    const centre = imageToPage(view, referenceCentre(g0));
    const { geometry: g1 } = await resizeWithHandle(page, 'mr', (from) => {
      const away = Math.hypot(from.x - centre.x, from.y - centre.y);
      return {
        x: from.x + ((from.x - centre.x) / away) * 40,
        y: from.y + ((from.y - centre.y) / away) * 40,
      };
    });

    for (const i of [0, 3]) {
      expectPointClose(
        referenceCorners(g1)[i]!,
        referenceCorners(g0)[i]!,
        0.05,
        `corner ${i} (must not move)`,
      );
    }
    expect(g1.rotation).toBeCloseTo(0, 9);
    expect(g1.height).toBeCloseTo(g0.height, 3);
    expect(Math.abs(g1.width - (g0.width + 40 / scaleOf(view)))).toBeLessThanOrEqual(1);

    await deselect(page);
    await expectPaintedAs(page, g1, 'resized in the rotated view');
    await resetView(page);
    await expectPaintedAs(page, g1, 'after resetting the view');
  });
});
