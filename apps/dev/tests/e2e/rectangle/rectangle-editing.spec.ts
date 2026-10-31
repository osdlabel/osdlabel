/**
 * Part of the rectangle suite. Pins that editing a rectangle with the select
 * tool's handles, through the real input routing, stores what the user did
 * and paints what is stored:
 *
 * - rotating with the rotation handle changes only `rotation`; the centre the
 *   rectangle turns about stays put;
 * - dragging the body moves `origin` by the drag, and nothing else;
 * - resizing from any of the eight handles keeps the opposite corner or edge
 *   where it was, and so does resizing a rotated rectangle from its four
 *   corner handles and its top and right side handles; a side handle pulled
 *   past the opposite side turns the box over that side;
 *
 * and after every edit the painted pixels are the stored geometry's corners.
 *
 * Every gesture is made without modifier keys. With Shift, a side handle
 * skews the rectangle instead, which its stored geometry cannot express: a
 * known limitation, tracked separately, and not pinned here.
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
  readAnnotations,
  referenceCentre,
  referenceCorners,
  resizeWithHandle,
  rotateWithHandle,
  scaleOf,
  selectAt,
  type ControlName,
  type Point,
  type StoredRectangle,
  type View,
} from './helpers.js';

/** Image-space drag ends of the rectangle every test starts from: 210×130 px. */
const A: Point = { x: 480.3, y: 290.6 };
const B: Point = { x: 690.8, y: 420.1 };
const SCALE = 1.37;

/**
 * Draw the starting rectangle, select it, and turn it `degrees` with its
 * handle; the rotation must take, or what follows tests an unrotated box.
 */
async function drawAndRotate(page: Page, view: View, degrees: number): Promise<StoredRectangle> {
  const drawn = await drawRectangle(page, view, A, B);
  if (degrees === 0) return drawn;
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

test.describe('Rectangle suite: editing', () => {
  for (const degrees of [30, -50, 135]) {
    test(`rotating ${degrees}° with the rotation handle changes only the rotation`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale: SCALE });
      const before = await drawRectangle(page, view, A, B);
      expect(before.geometry.rotation).toBe(0);

      await selectAt(page, bodyPoint(view, before.geometry), before.id);
      const after = await rotateWithHandle(
        page,
        imageToPage(view, referenceCentre(before.geometry)),
        degrees,
      );

      expect(after.id).toBe(before.id);
      // The box before rotation is untouched…
      expectGeometryClose(
        { ...after.geometry, rotation: 0 },
        { ...before.geometry, rotation: 0 },
        0.5,
      );
      // …and so is the centre it turns about.
      expectPointClose(
        referenceCentre(after.geometry),
        referenceCentre(before.geometry),
        0.5,
        'the centre',
      );
      // The rotation is what the handle was carried through, clockwise positive.
      expect(Math.abs(angleBetween(after.geometry.rotation, degrees))).toBeLessThanOrEqual(1);

      await deselect(page);
      await expectPaintedAs(page, after.geometry, `rotated ${degrees}°`);
    });
  }

  for (const degrees of [0, 30]) {
    test(`dragging the body moves the origin by the drag (rotation ${degrees}°)`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale: SCALE });
      const before = await drawAndRotate(page, view, degrees);

      const start = bodyPoint(view, before.geometry);
      const end = { x: start.x + 57, y: start.y - 33 };
      const moved = {
        x: pageToImage(view, end).x - pageToImage(view, start).x,
        y: pageToImage(view, end).y - pageToImage(view, start).y,
      };
      await selectAt(page, start, before.id);
      const after = await moveBody(page, start, end);

      expectGeometryClose(
        after.geometry,
        {
          ...before.geometry,
          origin: { x: before.geometry.origin.x + moved.x, y: before.geometry.origin.y + moved.y },
        },
        0.05,
      );

      await deselect(page);
      await expectPaintedAs(page, after.geometry, `moved, rotation ${degrees}°`);
    });
  }

  /**
   * Each handle, the outward direction it is pulled in (screen px), and the
   * indices into `referenceCorners` (top-left, top-right, bottom-right,
   * bottom-left) of the corners that must not move.
   */
  const HANDLES: readonly {
    readonly handle: Exclude<ControlName, 'mtr'>;
    readonly pull: Point;
    readonly fixed: readonly number[];
  }[] = [
    { handle: 'tl', pull: { x: -45, y: -30 }, fixed: [2] },
    { handle: 'tr', pull: { x: 45, y: -30 }, fixed: [3] },
    { handle: 'br', pull: { x: 45, y: 30 }, fixed: [0] },
    { handle: 'bl', pull: { x: -45, y: 30 }, fixed: [1] },
    { handle: 'ml', pull: { x: -45, y: 0 }, fixed: [1, 2] },
    { handle: 'mr', pull: { x: 45, y: 0 }, fixed: [0, 3] },
    { handle: 'mt', pull: { x: 0, y: -30 }, fixed: [2, 3] },
    { handle: 'mb', pull: { x: 0, y: 30 }, fixed: [0, 1] },
  ];

  for (const { handle, pull, fixed } of HANDLES) {
    test(`resizing from the ${handle} handle keeps the opposite side where it was`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale: SCALE });
      const before = await drawRectangle(page, view, A, B);
      await selectAt(page, bodyPoint(view, before.geometry), before.id);

      const after = await resizeWithHandle(page, handle, (from) => ({
        x: from.x + pull.x,
        y: from.y + pull.y,
      }));
      const g0 = before.geometry;
      const g1 = after.geometry;

      const cornersBefore = referenceCorners(g0);
      const cornersAfter = referenceCorners(g1);
      for (const i of fixed) {
        expectPointClose(cornersAfter[i]!, cornersBefore[i]!, 0.05, `corner ${i} (must not move)`);
      }
      expect(g1.rotation).toBeCloseTo(0, 9);

      const s = scaleOf(view);
      if (pull.x !== 0 && pull.y !== 0) {
        // A corner scales uniformly (Fabric's default): bigger, same proportions.
        expect(g1.width).toBeGreaterThan(g0.width + 10);
        expect(g1.width / g1.height).toBeCloseTo(g0.width / g0.height, 4);
      } else if (pull.x !== 0) {
        // A side handle moves its side by the pull, and leaves the other dimension.
        expect(g1.height).toBeCloseTo(g0.height, 3);
        expect(Math.abs(g1.width - (g0.width + Math.abs(pull.x) / s))).toBeLessThanOrEqual(1);
      } else {
        expect(g1.width).toBeCloseTo(g0.width, 3);
        expect(Math.abs(g1.height - (g0.height + Math.abs(pull.y) / s))).toBeLessThanOrEqual(1);
      }

      await deselect(page);
      await expectPaintedAs(page, g1, `resized from ${handle}`);
    });
  }

  /**
   * The handles a rotated rectangle is resized from, and the indices into
   * `referenceCorners` of the corners opposite each, which must not move.
   * Each handle is pulled straight away from the centre, which is outward
   * whatever the rotation.
   */
  const ROTATED_HANDLES: readonly {
    readonly handle: 'tl' | 'tr' | 'br' | 'bl' | 'mt' | 'mr';
    readonly fixed: readonly number[];
  }[] = [
    { handle: 'tl', fixed: [2] },
    { handle: 'tr', fixed: [3] },
    { handle: 'br', fixed: [0] },
    { handle: 'bl', fixed: [1] },
    { handle: 'mt', fixed: [2, 3] },
    { handle: 'mr', fixed: [0, 3] },
  ];

  for (const { handle, fixed } of ROTATED_HANDLES) {
    test(`resizing a rotated rectangle from its ${handle} handle: the opposite side stays, stored corners are the painted ones`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale: SCALE });
      const before = await drawAndRotate(page, view, 30);
      const g0 = before.geometry;

      await selectAt(page, bodyPoint(view, g0), before.id);
      const centre = imageToPage(view, referenceCentre(g0));
      const { geometry: g1 } = await resizeWithHandle(page, handle, (from) => {
        const away = Math.hypot(from.x - centre.x, from.y - centre.y);
        return {
          x: from.x + ((from.x - centre.x) / away) * 50,
          y: from.y + ((from.y - centre.y) / away) * 50,
        };
      });

      expect(g1.rotation).toBeCloseTo(g0.rotation, 3);
      for (const i of fixed) {
        expectPointClose(
          referenceCorners(g1)[i]!,
          referenceCorners(g0)[i]!,
          0.05,
          `corner ${i} (must not move)`,
        );
      }
      if (handle === 'mr') {
        expect(g1.width).toBeGreaterThan(g0.width + 10);
        expect(g1.height).toBeCloseTo(g0.height, 3);
      } else if (handle === 'mt') {
        expect(g1.height).toBeGreaterThan(g0.height + 10);
        expect(g1.width).toBeCloseTo(g0.width, 3);
      } else {
        expect(g1.width).toBeGreaterThan(g0.width + 10);
        expect(g1.width / g1.height).toBeCloseTo(g0.width / g0.height, 4);
      }

      await deselect(page);
      await expectPaintedAs(page, g1, `rotated, then resized from ${handle}`);
    });
  }

  test('pulling a side handle past the opposite side flips the box over that side', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const before = await drawRectangle(page, view, A, B);
    const g0 = before.geometry;
    await selectAt(page, bodyPoint(view, g0), before.id);

    // Carry the right handle 80 screen px beyond the left side.
    const leftSide = imageToPage(view, { x: g0.origin.x, y: 0 }).x;
    const { geometry: g1 } = await resizeWithHandle(
      page,
      'mr',
      (from) => ({ x: leftSide - 80, y: from.y }),
      10,
    );
    // The premise: Fabric turned the object over rather than stopping at zero width.
    const [saved] = await readAnnotations(page);
    expect(saved!.rawAnnotationData.data['flipX']).toBe(true);

    // The box now lies left of where the left side was, and is as tall as before.
    expect(g1.origin.x + g1.width).toBeLessThanOrEqual(g0.origin.x + 0.5);
    expect(g1.width).toBeGreaterThan(30);
    expect(g1.height).toBeCloseTo(g0.height, 3);
    expect(g1.origin.y).toBeCloseTo(g0.origin.y, 3);

    await deselect(page);
    await expectPaintedAs(page, g1, 'flipped over its left side');
  });
});
