/**
 * Part of the rectangle suite. Pins that Shift never skews a rectangle, through
 * the real input routing:
 *
 * - Shift + a side handle resizes the box along that handle's axis, exactly
 *   as the handle does without Shift: the part of the drag along the side is
 *   ignored, the opposite side stays where it was, and nothing is skewed.
 *   Fabric's default side handles take Shift (its `altActionKey`) as "skew",
 *   which turned the box into a parallelogram that its stored geometry, an
 *   unskewed box, could not describe;
 * - Shift + a corner handle still resizes the box freely, as Fabric's default
 *   corner does, keeping the opposite corner;
 *
 * and after every edit the painted pixels are the stored geometry's corners.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures.js';
import {
  angleBetween,
  bodyPoint,
  deselect,
  drawRectangle,
  expectPaintedAs,
  expectPointClose,
  imageToPage,
  openAnnotator,
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
const DEG = Math.PI / 180;

/**
 * Draw the starting rectangle, turn it `degrees` with its handle, and leave it
 * selected. Every commit rebuilds the cell's objects, which drops the
 * selection, so it is selected again after the turn.
 */
async function drawSelectAndRotate(
  page: Page,
  view: View,
  degrees: number,
): Promise<StoredRectangle> {
  const drawn = await drawRectangle(page, view, A, B);
  await selectAt(page, bodyPoint(view, drawn.geometry), drawn.id);
  if (degrees === 0) return drawn;
  const rotated = await rotateWithHandle(
    page,
    imageToPage(view, referenceCentre(drawn.geometry)),
    degrees,
  );
  expect(
    Math.abs(angleBetween(rotated.geometry.rotation, degrees)),
    `turned ${degrees}° with the handle, stored ${rotated.geometry.rotation}°`,
  ).toBeLessThanOrEqual(1);
  await selectAt(page, bodyPoint(view, rotated.geometry), rotated.id);
  return rotated;
}

/** Resize with `handle` while holding Shift, pressed before the handle and released after. */
async function resizeWithShift(
  page: Page,
  handle: Exclude<ControlName, 'mtr'>,
  to: (from: Point) => Point,
): Promise<StoredRectangle> {
  await page.keyboard.down('Shift');
  try {
    return await resizeWithHandle(page, handle, to);
  } finally {
    await page.keyboard.up('Shift');
  }
}

/** The stored Fabric data's skew: what Shift + a side handle used to leave behind. */
async function storedSkew(page: Page): Promise<{ skewX: unknown; skewY: unknown }> {
  const all = await readAnnotations(page);
  expect(all).toHaveLength(1);
  const data = all[0]!.rawAnnotationData.data;
  return { skewX: data['skewX'], skewY: data['skewY'] };
}

test.describe('Rectangle suite: Shift', () => {
  /**
   * Each side handle, on an unrotated rectangle: the screen-px pull outward
   * (which resizes) and along the side (which Fabric's default would have
   * skewed by), and the indices into `referenceCorners` that must not move.
   */
  const SIDES: readonly {
    readonly handle: 'mr' | 'mb';
    readonly out: Point;
    readonly along: Point;
    readonly fixed: readonly number[];
  }[] = [
    { handle: 'mr', out: { x: 45, y: 0 }, along: { x: 0, y: -35 }, fixed: [0, 3] },
    { handle: 'mb', out: { x: 0, y: 30 }, along: { x: 40, y: 0 }, fixed: [0, 1] },
  ];

  for (const { handle, out, along, fixed } of SIDES) {
    test(`Shift + the ${handle} handle, dragged out and along its side, resizes as without Shift and skews nothing`, async ({
      page,
    }) => {
      const view = await openAnnotator(page, { imageScale: SCALE });
      const { geometry: g0 } = await drawSelectAndRotate(page, view, 0);

      const { geometry: g1 } = await resizeWithShift(page, handle, (from) => ({
        x: from.x + out.x + along.x,
        y: from.y + out.y + along.y,
      }));
      expect(await storedSkew(page)).toEqual({ skewX: 0, skewY: 0 });

      const s = scaleOf(view);
      for (const i of fixed) {
        expectPointClose(
          referenceCorners(g1)[i]!,
          referenceCorners(g0)[i]!,
          0.05,
          `corner ${i} (must not move)`,
        );
      }
      expect(g1.rotation).toBeCloseTo(0, 9);
      if (out.x !== 0) {
        expect(Math.abs(g1.width - (g0.width + out.x / s))).toBeLessThanOrEqual(1);
        expect(g1.height).toBeCloseTo(g0.height, 3);
      } else {
        expect(Math.abs(g1.height - (g0.height + out.y / s))).toBeLessThanOrEqual(1);
        expect(g1.width).toBeCloseTo(g0.width, 3);
      }

      await deselect(page);
      await expectPaintedAs(page, g1, `Shift + ${handle}`);
    });
  }

  test('Shift + the mr handle of a rectangle turned 30°, dragged out and along its side, resizes it and skews nothing', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const { geometry: g0 } = await drawSelectAndRotate(page, view, 30);
    const r = g0.rotation * DEG;
    // Outward along the box's own +x, and along its right side (its +y).
    const outward = { x: Math.cos(r), y: Math.sin(r) };
    const alongSide = { x: -Math.sin(r), y: Math.cos(r) };

    const { geometry: g1 } = await resizeWithShift(page, 'mr', (from) => ({
      x: from.x + 50 * outward.x + 35 * alongSide.x,
      y: from.y + 50 * outward.y + 35 * alongSide.y,
    }));
    expect(await storedSkew(page)).toEqual({ skewX: 0, skewY: 0 });

    const s = scaleOf(view);
    expect(g1.rotation).toBeCloseTo(g0.rotation, 3);
    expect(Math.abs(g1.width - (g0.width + 50 / s))).toBeLessThanOrEqual(1);
    expect(g1.height).toBeCloseTo(g0.height, 3);
    for (const i of [0, 3]) {
      expectPointClose(
        referenceCorners(g1)[i]!,
        referenceCorners(g0)[i]!,
        0.05,
        `corner ${i} (must not move)`,
      );
    }

    await deselect(page);
    await expectPaintedAs(page, g1, 'turned 30°, then Shift + mr');
  });

  test('Shift + a corner handle still resizes freely, keeping the opposite corner', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: SCALE });
    const { geometry: g0 } = await drawSelectAndRotate(page, view, 0);

    // Wider and shorter: without Shift the corner would keep the proportions.
    const { geometry: g1 } = await resizeWithShift(page, 'br', (from) => ({
      x: from.x + 45,
      y: from.y - 25,
    }));
    expect(await storedSkew(page)).toEqual({ skewX: 0, skewY: 0 });

    const s = scaleOf(view);
    expectPointClose(
      referenceCorners(g1)[0]!,
      referenceCorners(g0)[0]!,
      0.05,
      'the top-left corner (must not move)',
    );
    expect(Math.abs(g1.width - (g0.width + 45 / s))).toBeLessThanOrEqual(1);
    expect(Math.abs(g1.height - (g0.height - 25 / s))).toBeLessThanOrEqual(1);
    expect(g1.rotation).toBeCloseTo(0, 9);

    await deselect(page);
    await expectPaintedAs(page, g1, 'Shift + br');
  });
});
