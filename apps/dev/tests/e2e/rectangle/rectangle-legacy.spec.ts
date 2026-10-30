/**
 * Part of the rectangle suite. Pins that a rectangle saved by a release up to
 * 0.21.0 is imported as saved and painted where that release painted it.
 *
 * Those releases built a rectangle with no origin set, so under Fabric 7's
 * default centre origin the point saved as its Fabric `left`/`top` was the
 * centre it was painted about, and its geometry's `origin` was read back from
 * the same point. Importing changes neither: the saved Fabric data still
 * paints the rectangle where the user saw it, and correcting the geometry is
 * the host's choice, through `migrateLegacyRectangle`. The data here is
 * written as such a release saved it, from a rectangle drawn now; how a
 * drawn rectangle is stored and painted today is `rectangle-drawing.spec.ts`'s
 * business.
 */
import { test, expect } from '../helpers/fixtures.js';
import {
  deselect,
  drawRectangle,
  expectPaintedAs,
  importAnnotations,
  openAnnotator,
  readAnnotations,
  readOnlyRectangle,
  type Point,
  type RectangleGeometry,
  type StoredAnnotation,
} from './helpers.js';

/**
 * Image-space drag ends: a 150.5×89.5 px box with fractional corners, its
 * first corner near the image's centre so the box 0.21.0 painted about that
 * corner, turned or not, stays in view.
 */
const A: Point = { x: 600.3, y: 380.6 };
const B: Point = { x: 750.8, y: 470.1 };

/**
 * `drawn`, rewritten as a release up to 0.21.0 saved it after turning it
 * `rotation` degrees: the geometry's `origin` as both its origin and the
 * Fabric object's `left`/`top`, under a centre origin, with the rotation as
 * both the geometry's and the object's angle. `toObject()` rounded
 * `left`/`top` to 4 decimals; the geometry kept every digit.
 */
function asSavedBy0210(
  drawn: StoredAnnotation,
  geometry: RectangleGeometry,
  rotation: number,
): StoredAnnotation & { readonly geometry: RectangleGeometry } {
  return {
    ...drawn,
    geometry: { ...geometry, rotation },
    rawAnnotationData: {
      ...drawn.rawAnnotationData,
      data: {
        ...drawn.rawAnnotationData.data,
        left: Number(geometry.origin.x.toFixed(4)),
        top: Number(geometry.origin.y.toFixed(4)),
        originX: 'center',
        originY: 'center',
        angle: rotation,
      },
    },
  };
}

test.describe('Rectangle suite: legacy data', () => {
  test('an unrotated rectangle from 0.21.0 is painted centred on its saved origin, its geometry as saved', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 1.37 });
    const { geometry } = await drawRectangle(page, view, A, B);
    const [drawn] = await readAnnotations(page);
    const legacy = asSavedBy0210(drawn!, geometry, 0);

    await importAnnotations(page, JSON.stringify([legacy]));
    await deselect(page);

    // Importing changes nothing: the geometry is as it was saved.
    const loaded = await readOnlyRectangle(page);
    expect(loaded.geometry).toEqual(legacy.geometry);

    // Painted where 0.21.0 painted it: centred on the saved origin, which is
    // the corner the user dragged from.
    const g = legacy.geometry;
    await expectPaintedAs(
      page,
      { ...g, origin: { x: g.origin.x - g.width / 2, y: g.origin.y - g.height / 2 } },
      'as 0.21.0 painted it',
    );
    // The premise: that is not where today's reading of the geometry puts it.
    await expect(expectPaintedAs(page, g, 'by its saved geometry')).rejects.toThrow(
      /by its saved geometry/,
    );
  });

  test('a rectangle 0.21.0 saved turned 90° is painted turned about its saved origin, its geometry as saved', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 1.37 });
    const { geometry } = await drawRectangle(page, view, A, B);
    const [drawn] = await readAnnotations(page);
    const legacy = asSavedBy0210(drawn!, geometry, 90);

    await importAnnotations(page, JSON.stringify([legacy]));
    await deselect(page);

    const loaded = await readOnlyRectangle(page);
    expect(loaded.geometry).toEqual(legacy.geometry);

    // Derived by hand: centred on the saved origin and turned a quarter, the
    // w×h box spans h across and w down, so it covers the same pixels as the
    // unrotated h×w box about that centre.
    const { origin: c, width: w, height: h } = legacy.geometry;
    await expectPaintedAs(
      page,
      {
        type: 'rectangle',
        origin: { x: c.x - h / 2, y: c.y - w / 2 },
        width: h,
        height: w,
        rotation: 0,
      },
      'as 0.21.0 painted it, turned 90°',
    );
    // The premise: that is not where today's reading of the geometry puts it.
    await expect(expectPaintedAs(page, legacy.geometry, 'by its saved geometry')).rejects.toThrow(
      /by its saved geometry/,
    );
  });
});
