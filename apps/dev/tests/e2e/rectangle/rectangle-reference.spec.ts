/**
 * Part of the rectangle suite. Pins this directory's independent corner
 * reference (`helpers.ts`) to the contract's worked example, so every other
 * spec here that places probes with it is placing them where the contract
 * says the rectangle is.
 *
 * Pure arithmetic: it never navigates. It is still a Playwright test, so the
 * auto `frameworkGuard` fixture (`../helpers/fixtures.ts`) still opens a
 * blank page for it; the checks share one test so that cost is paid once.
 */
import { test, expect } from '../helpers/fixtures.js';
import {
  boxFromDrag,
  canvasToImage,
  imageToCanvas,
  referenceCentre,
  referenceCorners,
  type RectangleGeometry,
  type View,
} from './helpers.js';

const worked = (rotation: number): RectangleGeometry => ({
  type: 'rectangle',
  origin: { x: 200, y: 100 },
  width: 100,
  height: 50,
  rotation,
});

const rounded = (points: readonly { x: number; y: number }[]) =>
  points.map((p) => ({ x: Number(p.x.toFixed(9)) + 0, y: Number(p.y.toFixed(9)) + 0 }));

test.describe('Rectangle suite: the independent corner reference', () => {
  test('matches the worked example, and its view mapping inverts', () => {
    // At rotation 0 it covers x 200–300, y 100–150.
    expect(rounded(referenceCorners(worked(0))), 'rotation 0').toEqual([
      { x: 200, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 150 },
      { x: 200, y: 150 },
    ]);

    // At rotation 90 it turns about the centre (250, 125) to cover x 225–275,
    // y 75–175. +90 takes +x onto +y: the unrotated top-left corner goes to
    // the top right.
    expect(referenceCentre(worked(90)), 'centre at rotation 90').toEqual({ x: 250, y: 125 });
    expect(rounded(referenceCorners(worked(90))), 'rotation 90').toEqual([
      { x: 275, y: 75 },
      { x: 275, y: 175 },
      { x: 225, y: 175 },
      { x: 225, y: 75 },
    ]);

    // The centre does not depend on the rotation.
    for (const rotation of [0, 15, 30, 45, 90, 135, 180, -30, 270, 359.5]) {
      expect(referenceCentre(worked(rotation)).x, `centre x at ${rotation}°`).toBeCloseTo(250, 9);
      expect(referenceCentre(worked(rotation)).y, `centre y at ${rotation}°`).toBeCloseTo(125, 9);
    }

    // A drag in any direction spans the same box.
    const a = { x: 10, y: 20 };
    const b = { x: 40.5, y: 70.25 };
    const expected = boxFromDrag(a, b);
    expect(expected).toEqual({
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 30.5,
      height: 50.25,
      rotation: 0,
    });
    expect(boxFromDrag(b, a), 'dragged up and left').toEqual(expected);
    expect(boxFromDrag({ x: a.x, y: b.y }, { x: b.x, y: a.y }), 'dragged up and right').toEqual(
      expected,
    );
    expect(boxFromDrag({ x: b.x, y: a.y }, { x: a.x, y: b.y }), 'dragged down and left').toEqual(
      expected,
    );

    // The canvas mapping inverts, under a 90° view rotation composed with a
    // horizontal flip, as the overlay builds it.
    const view: View = {
      vpt: [0, 1.5, 1.5, 0, 40, -7],
      canvasOrigin: { x: 0, y: 0 },
      canvasSize: { width: 100, height: 100 },
    };
    const p = { x: 123.25, y: -45.5 };
    expect(imageToCanvas(view, p)).toEqual({ x: 1.5 * -45.5 + 40, y: 1.5 * 123.25 - 7 });
    const back = canvasToImage(view, imageToCanvas(view, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });
});
