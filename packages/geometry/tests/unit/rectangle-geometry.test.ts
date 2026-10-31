// Part of the rectangle suite (every test file with "rectangle" in its name).
// This file pins the maths every other layer is checked against:
// rectangleCorners, centroid and boundingBox must describe the box
// origin..origin + (width, height) turned `rotation` degrees clockwise
// (image y points down) about its own centre, origin + (width / 2, height / 2),
// at every rotation, position and size. Expected values are written by hand or
// come from ./rectangle-reference.ts, never from the functions under test.
import { describe, expect, it } from 'vitest';
import type { Point, RectangleGeometry } from '@osdlabel/annotation';
import {
  area,
  boundingBox,
  centroid,
  length,
  perimeter,
  rectangleCorners,
} from '../../src/index.js';
import {
  RECTANGLE_ROTATIONS,
  rectangle,
  rectangleMatrix,
  referenceCorners,
  workedExample,
  type Corners,
} from './rectangle-reference.js';

/** `toBeCloseTo` digits: differences must stay below 5e-8 image px. */
const DIGITS = 7;
const p = (x: number, y: number): Point => ({ x, y });

function expectPoint(actual: Point, expected: Point, label: string): void {
  expect(actual.x, `${label}: x`).toBeCloseTo(expected.x, DIGITS);
  expect(actual.y, `${label}: y`).toBeCloseTo(expected.y, DIGITS);
}

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

function expectCorners(actual: Corners, expected: Corners, label: string): void {
  expect(actual, label).toHaveLength(4);
  for (let i = 0; i < 4; i++) {
    expectPoint(actual[i]!, expected[i]!, `${label}, ${CORNER_NAMES[i]!}`);
  }
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const len = (a: Point): number => Math.hypot(a.x, a.y);
const isZeroTurn = (rotation: number): boolean => ((rotation % 360) + 360) % 360 === 0;

/** Twice the shoelace sum, taken relative to the first corner to avoid cancellation. */
function signedArea(corners: Corners): number {
  const rel = corners.map((c) => sub(c, corners[0]));
  let sum = 0;
  for (let i = 0; i < rel.length; i++) {
    const a = rel[i]!;
    const b = rel[(i + 1) % rel.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

// ── The worked example ─────────────────────────────────────────────────────

describe('rectangle geometry: the worked example, by hand', () => {
  it('origin (200,100), 100×50 at 90°: centre (250,125), covers x 225–275, y 75–175', () => {
    const r = workedExample(90);
    expect(centroid(r)).toEqual({ x: 250, y: 125 });
    expectCorners(
      rectangleCorners(r),
      [p(275, 75), p(275, 175), p(225, 175), p(225, 75)],
      'worked example at 90°',
    );
    const box = boundingBox(r);
    expectPoint(box.min, p(225, 75), 'bounding box min');
    expectPoint(box.max, p(275, 175), 'bounding box max');
  });

  it('at 0° it covers x 200–300, y 100–150, with origin as its top-left corner', () => {
    const r = workedExample(0);
    expect(centroid(r)).toEqual({ x: 250, y: 125 });
    expect(rectangleCorners(r)).toEqual([p(200, 100), p(300, 100), p(300, 150), p(200, 150)]);
    expect(boundingBox(r)).toEqual({ min: p(200, 100), max: p(300, 150) });
  });

  it('is not centred on its origin (how every rectangle was painted before #244)', () => {
    const r = workedExample(0);
    expect(centroid(r)).not.toEqual(r.origin);
    expect(boundingBox(r)).not.toEqual({ min: p(150, 75), max: p(250, 125) });
  });

  it('turns about its centre, not its origin: once rotated, origin is no corner', () => {
    const corners = rectangleCorners(workedExample(90));
    for (const corner of corners) {
      expect(len(sub(corner, p(200, 100))), 'distance from origin').toBeGreaterThan(1);
    }
    // Turning about the origin would have put the corners here instead.
    expect(corners[1].x).not.toBeCloseTo(200, DIGITS);
    expect(corners[2].x).not.toBeCloseTo(150, DIGITS);
  });
});

// ── Exact cases ────────────────────────────────────────────────────────────

const S = Math.SQRT1_2; // sin 45° = cos 45°
const K = Math.sqrt(3) / 2; // cos 30°

/** The worked example's box (centre (250,125), half-sizes 50 × 25) at exact angles. */
const EXACT: readonly {
  readonly rotation: number;
  readonly corners: Corners;
  readonly min: Point;
  readonly max: Point;
}[] = [
  {
    rotation: 0,
    corners: [p(200, 100), p(300, 100), p(300, 150), p(200, 150)],
    min: p(200, 100),
    max: p(300, 150),
  },
  {
    // cos and sin differ here, so a swapped pair or a radian/degree slip shows.
    rotation: 30,
    corners: [
      p(262.5 - 50 * K, 100 - 25 * K),
      p(262.5 + 50 * K, 150 - 25 * K),
      p(237.5 + 50 * K, 150 + 25 * K),
      p(237.5 - 50 * K, 100 + 25 * K),
    ],
    min: p(237.5 - 50 * K, 100 - 25 * K),
    max: p(262.5 + 50 * K, 150 + 25 * K),
  },
  {
    rotation: 45,
    corners: [
      p(250 - 25 * S, 125 - 75 * S),
      p(250 + 75 * S, 125 + 25 * S),
      p(250 + 25 * S, 125 + 75 * S),
      p(250 - 75 * S, 125 - 25 * S),
    ],
    min: p(250 - 75 * S, 125 - 75 * S),
    max: p(250 + 75 * S, 125 + 75 * S),
  },
  {
    rotation: 90,
    corners: [p(275, 75), p(275, 175), p(225, 175), p(225, 75)],
    min: p(225, 75),
    max: p(275, 175),
  },
  {
    rotation: 180,
    corners: [p(300, 150), p(200, 150), p(200, 100), p(300, 100)],
    min: p(200, 100),
    max: p(300, 150),
  },
  {
    rotation: 270,
    corners: [p(225, 175), p(225, 75), p(275, 75), p(275, 175)],
    min: p(225, 75),
    max: p(275, 175),
  },
  {
    rotation: -90,
    corners: [p(225, 175), p(225, 75), p(275, 75), p(275, 175)],
    min: p(225, 75),
    max: p(275, 175),
  },
  {
    // 360 ≡ 0
    rotation: 360,
    corners: [p(200, 100), p(300, 100), p(300, 150), p(200, 150)],
    min: p(200, 100),
    max: p(300, 150),
  },
];

describe('rectangleCorners, centroid, boundingBox: exact cases', () => {
  it.each(EXACT)('origin (200,100), 100×50 at $rotation°', ({ rotation, corners, min, max }) => {
    const r = workedExample(rotation);
    expectCorners(rectangleCorners(r), corners, `${rotation}°`);
    expect(centroid(r)).toEqual({ x: 250, y: 125 });
    const box = boundingBox(r);
    expectPoint(box.min, min, `${rotation}° box min`);
    expectPoint(box.max, max, `${rotation}° box max`);
  });
});

describe('oracle self-check (pins the test reference, not the library)', () => {
  it('the test reference agrees with the worked example by hand', () => {
    expectCorners(
      referenceCorners(workedExample(90)),
      [p(275, 75), p(275, 175), p(225, 175), p(225, 75)],
      'reference at 90°',
    );
    expectCorners(
      referenceCorners(workedExample(0)),
      [p(200, 100), p(300, 100), p(300, 150), p(200, 150)],
      'reference at 0°',
    );
  });

  it('the test reference agrees with every exact case', () => {
    for (const { rotation, corners } of EXACT) {
      expectCorners(referenceCorners(workedExample(rotation)), corners, `reference ${rotation}°`);
    }
  });
});

// ── Order and direction ────────────────────────────────────────────────────

describe('rectangleCorners: corner order and rotation direction', () => {
  it('+90° takes the +x axis onto +y: the top edge then points straight down', () => {
    const [tl, tr, , bl] = rectangleCorners(workedExample(90));
    expectPoint(sub(tr, tl), p(0, 100), 'TL→TR');
    expectPoint(sub(bl, tl), p(-50, 0), 'TL→BL');
  });

  it('a small positive rotation turns clockwise on screen (y down)', () => {
    const [tl, tr, , bl] = rectangleCorners(workedExample(15));
    expect(tr.y, 'TR sinks below TL').toBeGreaterThan(tl.y);
    expect(bl.x, 'BL swings left of TL').toBeLessThan(tl.x);
    const [tlNeg, trNeg] = rectangleCorners(workedExample(-15));
    expect(trNeg.y, 'at -15° TR rises above TL').toBeLessThan(tlNeg.y);
  });

  it.each(RECTANGLE_ROTATIONS)(
    'at %s°, TL→TR is w·(cos θ, sin θ) and TL→BL is h·(−sin θ, cos θ)',
    (rotation) => {
      const theta = (rotation * Math.PI) / 180;
      for (const { label, geometry } of rectangleMatrix(rotation)) {
        const [tl, tr, br, bl] = rectangleCorners(geometry);
        const along = p(geometry.width * Math.cos(theta), geometry.width * Math.sin(theta));
        const down = p(-geometry.height * Math.sin(theta), geometry.height * Math.cos(theta));
        expectPoint(sub(tr, tl), along, `${label}: TL→TR`);
        expectPoint(sub(br, bl), along, `${label}: BL→BR`);
        expectPoint(sub(bl, tl), down, `${label}: TL→BL`);
        expectPoint(sub(br, tr), down, `${label}: TR→BR`);
      }
    },
  );

  it.each(RECTANGLE_ROTATIONS)(
    'at %s°, the corners wind clockwise on screen: signed area +w·h',
    (rotation) => {
      for (const { label, geometry } of rectangleMatrix(rotation)) {
        const expected = geometry.width * geometry.height;
        const actual = signedArea(rectangleCorners(geometry));
        expect(actual / expected, label).toBeCloseTo(1, 9);
      }
    },
  );
});

// ── Properties over the matrix ─────────────────────────────────────────────

describe.each(RECTANGLE_ROTATIONS)('rectangle properties at %s°', (rotation) => {
  const matrix = rectangleMatrix(rotation);

  it('centroid is origin + (w/2, h/2), whatever the rotation', () => {
    for (const { label, geometry: r } of matrix) {
      expectPoint(
        centroid(r),
        p(r.origin.x + r.width / 2, r.origin.y + r.height / 2),
        `${label}: centroid`,
      );
    }
  });

  it('corners match the independent reference', () => {
    for (const { label, geometry } of matrix) {
      expectCorners(rectangleCorners(geometry), referenceCorners(geometry), label);
    }
  });

  it('corners form a w × h rectangle: sides, right angles, diagonals', () => {
    for (const { label, geometry: r } of matrix) {
      const [tl, tr, br, bl] = rectangleCorners(r);
      expect(len(sub(tr, tl)), `${label}: top`).toBeCloseTo(r.width, DIGITS);
      expect(len(sub(br, bl)), `${label}: bottom`).toBeCloseTo(r.width, DIGITS);
      expect(len(sub(bl, tl)), `${label}: left`).toBeCloseTo(r.height, DIGITS);
      expect(len(sub(br, tr)), `${label}: right`).toBeCloseTo(r.height, DIGITS);
      const diagonal = Math.hypot(r.width, r.height);
      expect(len(sub(br, tl)), `${label}: TL–BR`).toBeCloseTo(diagonal, DIGITS);
      expect(len(sub(bl, tr)), `${label}: TR–BL`).toBeCloseTo(diagonal, DIGITS);
      // Cosine of each corner's angle: 0 for a right angle.
      const cosAt = (a: Point, b: Point, c: Point): number =>
        dot(sub(a, b), sub(c, b)) / (len(sub(a, b)) * len(sub(c, b)));
      expect(cosAt(tr, tl, bl), `${label}: angle at TL`).toBeCloseTo(0, 9);
      expect(cosAt(tl, tr, br), `${label}: angle at TR`).toBeCloseTo(0, 9);
      expect(cosAt(tr, br, bl), `${label}: angle at BR`).toBeCloseTo(0, 9);
    }
  });

  it("the corners' mean is the centroid, and each corner is half a diagonal from it", () => {
    for (const { label, geometry: r } of matrix) {
      const corners = rectangleCorners(r);
      const mean = p(
        corners.reduce((s, c) => s + c.x, 0) / 4,
        corners.reduce((s, c) => s + c.y, 0) / 4,
      );
      const c = centroid(r);
      expectPoint(mean, c, `${label}: mean of corners`);
      for (const corner of corners) {
        expect(len(sub(corner, c)), `${label}: corner to centre`).toBeCloseTo(
          Math.hypot(r.width, r.height) / 2,
          DIGITS,
        );
      }
    }
  });

  it('the bounding box is tight: it holds every corner, each side touches one', () => {
    for (const { label, geometry } of matrix) {
      const corners = rectangleCorners(geometry);
      const { min, max } = boundingBox(geometry);
      for (const c of corners) {
        expect(c.x, `${label}: corner within min.x`).toBeGreaterThanOrEqual(min.x);
        expect(c.y, `${label}: corner within min.y`).toBeGreaterThanOrEqual(min.y);
        expect(c.x, `${label}: corner within max.x`).toBeLessThanOrEqual(max.x);
        expect(c.y, `${label}: corner within max.y`).toBeLessThanOrEqual(max.y);
      }
      const expectTouch = (side: string, pick: (c: Point) => number, edge: number): void => {
        const gap = Math.min(...corners.map((c) => Math.abs(pick(c) - edge)));
        expect(gap, `${label}: ${side} side to its nearest corner`).toBeLessThan(1e-9);
      };
      expectTouch('left', (c) => c.x, min.x);
      expectTouch('top', (c) => c.y, min.y);
      expectTouch('right', (c) => c.x, max.x);
      expectTouch('bottom', (c) => c.y, max.y);
    }
  });

  it('the bounding box is centred on the centroid, |w cos θ| + |h sin θ| wide', () => {
    const theta = (rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(theta));
    const sin = Math.abs(Math.sin(theta));
    for (const { label, geometry: r } of matrix) {
      const halfW = (r.width * cos + r.height * sin) / 2;
      const halfH = (r.width * sin + r.height * cos) / 2;
      const cx = r.origin.x + r.width / 2;
      const cy = r.origin.y + r.height / 2;
      const { min, max } = boundingBox(r);
      expectPoint(min, p(cx - halfW, cy - halfH), `${label}: box min`);
      expectPoint(max, p(cx + halfW, cy + halfH), `${label}: box max`);
    }
  });

  it('rotation moves the corners but not the centroid', () => {
    for (const { label, geometry } of matrix) {
      const unrotated: RectangleGeometry = { ...geometry, rotation: 0 };
      expectPoint(centroid(geometry), centroid(unrotated), `${label}: centroid`);
      const moved = rectangleCorners(geometry).some(
        (c, i) => len(sub(c, rectangleCorners(unrotated)[i]!)) > 1e-6,
      );
      expect(moved, `${label}: corners moved`).toBe(!isZeroTurn(rotation));
    }
  });

  it('moving the origin moves corners, centroid and bounding box by the same delta', () => {
    const delta = p(12.75, -3.5);
    for (const { label, geometry } of matrix) {
      const shifted: RectangleGeometry = {
        ...geometry,
        origin: p(geometry.origin.x + delta.x, geometry.origin.y + delta.y),
      };
      const before = rectangleCorners(geometry);
      const after = rectangleCorners(shifted);
      for (let i = 0; i < 4; i++) {
        expectPoint(sub(after[i]!, before[i]!), delta, `${label}: ${CORNER_NAMES[i]!}`);
      }
      expectPoint(sub(centroid(shifted), centroid(geometry)), delta, `${label}: centroid`);
      expectPoint(
        sub(boundingBox(shifted).min, boundingBox(geometry).min),
        delta,
        `${label}: box min`,
      );
      expectPoint(
        sub(boundingBox(shifted).max, boundingBox(geometry).max),
        delta,
        `${label}: box max`,
      );
    }
  });

  it('area is w·h, perimeter and length 2(w+h): rotation changes neither', () => {
    for (const { label, geometry: r } of matrix) {
      expect(area(r), `${label}: area`).toBeCloseTo(r.width * r.height, DIGITS);
      expect(perimeter(r), `${label}: perimeter`).toBeCloseTo(2 * (r.width + r.height), DIGITS);
      expect(length(r), `${label}: length`).toBeCloseTo(2 * (r.width + r.height), DIGITS);
    }
  });
});

// ── Periodicity and symmetry ───────────────────────────────────────────────

describe('rectangle rotation: whole and half turns', () => {
  it.each(RECTANGLE_ROTATIONS)('%s° plus or minus whole turns gives the same corners', (rot) => {
    for (const { label, geometry } of rectangleMatrix(rot)) {
      const corners = rectangleCorners(geometry);
      for (const turns of [-360, 360, 720]) {
        expectCorners(
          rectangleCorners({ ...geometry, rotation: rot + turns }),
          corners,
          `${label} ${turns >= 0 ? '+' : ''}${turns}°`,
        );
      }
    }
  });

  it.each(RECTANGLE_ROTATIONS)('%s° plus a half turn sends each corner to its opposite', (rot) => {
    for (const { label, geometry } of rectangleMatrix(rot)) {
      const [tl, tr, br, bl] = rectangleCorners(geometry);
      expectCorners(
        rectangleCorners({ ...geometry, rotation: rot + 180 }),
        [br, bl, tl, tr],
        `${label} +180°`,
      );
    }
  });
});

// ── Zero size ──────────────────────────────────────────────────────────────

describe('zero-size rectangles', () => {
  it.each(RECTANGLE_ROTATIONS)('0 × 0 at %s° collapses onto its origin', (rotation) => {
    const r = rectangle(p(17.5, -4.25), 0, 0, rotation);
    for (const corner of rectangleCorners(r)) expectPoint(corner, r.origin, 'corner');
    expectPoint(centroid(r), r.origin, 'centroid');
    const box = boundingBox(r);
    expectPoint(box.min, r.origin, 'box min');
    expectPoint(box.max, r.origin, 'box max');
    expect(area(r)).toBe(0);
    expect(perimeter(r)).toBe(0);
  });

  it('0 × 40 at 90° is a horizontal segment of length 40 centred on origin + (0, 20)', () => {
    const r = rectangle(p(10, 20), 0, 40, 90);
    expectPoint(centroid(r), p(10, 40), 'centroid');
    expectCorners(rectangleCorners(r), [p(30, 40), p(30, 40), p(-10, 40), p(-10, 40)], '0 × 40');
    const box = boundingBox(r);
    expectPoint(box.min, p(-10, 40), 'box min');
    expectPoint(box.max, p(30, 40), 'box max');
    expect(area(r)).toBe(0);
    expect(perimeter(r)).toBe(80);
  });
});
