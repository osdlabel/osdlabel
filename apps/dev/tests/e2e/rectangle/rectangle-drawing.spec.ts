/**
 * Part of the rectangle suite. Pins that drawing a rectangle stores the box
 * the user dragged, in image space, and paints exactly that box: while the
 * drag is in progress (the tool's preview) and once it is committed (the
 * object rebuilt from the stored data). Pixels are the judge of what is
 * painted; until #244 a drawn rectangle was painted centred on its first
 * corner, half its size away from its geometry.
 */
import { test, expect } from '../helpers/fixtures.js';
import {
  annotationsText,
  boxFromDrag,
  drawRectangle,
  expectGeometryClose,
  expectPaintedAs,
  imageToPage,
  onPixel,
  openAnnotator,
  pageToImage,
  previewStrokeWidth,
  readAnnotations,
  readOnlyRectangle,
  scaleOf,
  settle,
  type Point,
  type RectangleGeometry,
} from './helpers.js';

/** Image-space drag ends: a 210×130 px box with fractional corners. */
const CORNER_A: Point = { x: 480.3, y: 290.6 };
const CORNER_B: Point = { x: 690.8, y: 420.1 };

const DIRECTIONS = [
  { name: 'down and to the right', from: CORNER_A, to: CORNER_B },
  { name: 'up and to the left', from: CORNER_B, to: CORNER_A },
  {
    name: 'down and to the left',
    from: { x: CORNER_B.x, y: CORNER_A.y },
    to: { x: CORNER_A.x, y: CORNER_B.y },
  },
  {
    name: 'up and to the right',
    from: { x: CORNER_A.x, y: CORNER_B.y },
    to: { x: CORNER_B.x, y: CORNER_A.y },
  },
] as const;

test.describe('Rectangle suite: drawing', () => {
  for (const direction of DIRECTIONS) {
    test(`a drag ${direction.name} stores and paints the dragged box`, async ({ page }) => {
      // 1.37 screen px per image px: no image or screen pixel boundaries line up.
      const view = await openAnnotator(page, { imageScale: 1.37 });
      await page.getByTestId('tool-rectangle').click();

      const from = onPixel(imageToPage(view, direction.from));
      const to = onPixel(imageToPage(view, direction.to));
      // What the user actually dragged, after snapping to whole page pixels.
      const dragged = boxFromDrag(pageToImage(view, from), pageToImage(view, to));
      // Half a screen pixel, in image px.
      const tol = 0.5 / scaleOf(view);

      const empty = await annotationsText(page);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 6 });
      // Still held: the preview is painted under the drag, and nothing is stored.
      await settle(page);
      expect(await readAnnotations(page)).toEqual([]);
      await expectPaintedAs(page, dragged, 'the preview', {
        strokeWidth: await previewStrokeWidth(page),
      });

      await page.mouse.up();
      await settle(page, empty);

      const { geometry } = await readOnlyRectangle(page);
      expectGeometryClose(geometry, dragged, tol);
      await expectPaintedAs(page, geometry, 'the committed rectangle');
    });
  }

  test('at the fitted, fractional home zoom, the stored box is the drag within an image pixel', async ({
    page,
  }) => {
    const view = await openAnnotator(page);
    const scale = scaleOf(view);
    // The premise: one screen pixel spans more than one image pixel.
    expect(scale).toBeLessThan(1);

    await page.getByTestId('tool-rectangle').click();
    const from = onPixel(imageToPage(view, { x: 311.7, y: 207.2 }));
    const to = onPixel(imageToPage(view, { x: 805.4, y: 590.9 }));
    const dragged = boxFromDrag(pageToImage(view, from), pageToImage(view, to));
    const empty = await annotationsText(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await settle(page, empty);

    const { geometry } = await readOnlyRectangle(page);
    expectGeometryClose(geometry, dragged, 1);
    await expectPaintedAs(page, geometry, 'at home zoom');
  });

  test('a small rectangle at a high zoom is stored and painted where it was dragged', async ({
    page,
  }) => {
    // 4.6 screen px per image px: a 9.5×6.25 image-px box, 44×29 screen px.
    const view = await openAnnotator(page, { imageScale: 4.6 });
    await page.getByTestId('tool-rectangle').click();
    const start = pageToImage(view, {
      x: view.canvasOrigin.x + 400,
      y: view.canvasOrigin.y + 250,
    });
    const from = onPixel(imageToPage(view, start));
    const to = onPixel(imageToPage(view, { x: start.x + 9.5, y: start.y - 6.25 }));
    const dragged = boxFromDrag(pageToImage(view, from), pageToImage(view, to));
    const empty = await annotationsText(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await settle(page, empty);

    const { geometry } = await readOnlyRectangle(page);
    expectGeometryClose(geometry, dragged, 0.5 / scaleOf(view));
    await expectPaintedAs(page, geometry, 'at high zoom');
  });

  // Every spec here judges paint with `expectPaintedAs`; this keeps that
  // judge from passing anything. It must reject the pre-#244 placement and
  // misplacements of a few image px.
  test('the pixel judge rejects any geometry other than the painted one', async ({ page }) => {
    const view = await openAnnotator(page, { imageScale: 1.37 });
    const { geometry: g } = await drawRectangle(page, view, CORNER_A, CORNER_B);
    await expectPaintedAs(page, g, 'as drawn');

    const wrong: [string, RectangleGeometry][] = [
      [
        'centred on its origin, as before #244',
        { ...g, origin: { x: g.origin.x - g.width / 2, y: g.origin.y - g.height / 2 } },
      ],
      ['3 px to the right', { ...g, origin: { x: g.origin.x + 3, y: g.origin.y } }],
      ['3 px higher', { ...g, origin: { x: g.origin.x, y: g.origin.y - 3 } }],
      ['4 px narrower', { ...g, width: g.width - 4 }],
      ['4 px taller', { ...g, height: g.height + 4 }],
      ['turned 3° about its centre', { ...g, rotation: 3 }],
    ];
    for (const [name, geometry] of wrong) {
      // By a failed check, which names the geometry, not by a probe off the canvas.
      await expect(expectPaintedAs(page, geometry, name), name).rejects.toThrow(name);
    }
  });
});
