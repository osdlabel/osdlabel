/**
 * Part of the rectangle suite. Pins that converting a circle to a rectangle
 * (the toolbar's contextual convert action, shown while the circle is
 * selected) keeps the annotation's id, stores the circle's axis-aligned
 * bounding box, and paints that box. The rectangle's Fabric object is built
 * from the new geometry rather than drawn, so this is where the running app
 * places a rectangle from its geometry alone; the expected box is derived by
 * hand from the circle as stored.
 */
import { test, expect } from '../helpers/fixtures.js';
import {
  annotationsText,
  deselect,
  drag,
  expectGeometryClose,
  expectPaintedAs,
  imageToPage,
  onPixel,
  openAnnotator,
  readAnnotations,
  readOnlyRectangle,
  selectAt,
  settle,
  type RectangleGeometry,
} from './helpers.js';

interface CircleGeometry {
  readonly type: 'circle';
  readonly center: { readonly x: number; readonly y: number };
  readonly radius: number;
}

function isCircleGeometry(g: { readonly type: string }): g is CircleGeometry {
  return g.type === 'circle';
}

test.describe('Rectangle suite: a circle converted to a rectangle', () => {
  test('is stored and painted as the circle’s bounding box', async ({ page }) => {
    const view = await openAnnotator(page, { imageScale: 1.37 });

    // Drag a circle out from its centre, 60 px right and 45 px down: a radius
    // of 75 screen px.
    await page.getByTestId('tool-circle').click();
    const centre = onPixel(imageToPage(view, { x: 560.4, y: 350.2 }));
    const before = await annotationsText(page);
    await drag(page, centre, { x: centre.x + 60, y: centre.y + 45 }, 6);
    await settle(page, before);
    const drawn = await readAnnotations(page);
    expect(drawn, 'expected the one circle just drawn').toHaveLength(1);
    const stored = drawn[0]!;
    const circle = stored.geometry;
    if (!isCircleGeometry(circle)) throw new Error(`drew a ${circle.type}, not a circle`);
    // The premise: a circle big enough that a misplaced box would show.
    expect(circle.radius).toBeGreaterThan(40);

    await selectAt(page, centre, stored.id);
    const convert = page.getByTestId('convert-to-rect');
    await expect(convert).toBeEnabled();
    const asCircle = await annotationsText(page);
    await convert.click();
    await settle(page, asCircle);

    const converted = await readOnlyRectangle(page);
    expect(converted.id).toBe(stored.id);
    // The bounding box, derived by hand from the circle as stored.
    const box: RectangleGeometry = {
      type: 'rectangle',
      origin: { x: circle.center.x - circle.radius, y: circle.center.y - circle.radius },
      width: 2 * circle.radius,
      height: 2 * circle.radius,
      rotation: 0,
    };
    expectGeometryClose(converted.geometry, box, 1e-9);

    await deselect(page);
    await expectPaintedAs(page, box, 'converted from a circle');
  });
});
