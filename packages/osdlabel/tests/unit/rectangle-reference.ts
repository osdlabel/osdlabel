/**
 * Part of the rectangle suite (every test file with "rectangle" in its name).
 *
 * The test oracle for rectangles in this package: where a `RectangleGeometry`'s
 * corners are, computed without the library, and where Fabric actually paints
 * a `Rect`. The suite's invariant is that the two agree. Test trees cannot
 * import across packages, so this is this package's own copy of the oracle;
 * it is pinned to the contract's worked example by hand in
 * `rectangle-annotation.test.ts`.
 *
 * The contract: `origin`/`width`/`height` are the box before rotation,
 * `origin` to `origin + (width, height)`. `rotation` (degrees, clockwise in
 * image space where y points down, so +90 takes +x onto +y) turns that box
 * about its own centre, `origin + (width / 2, height / 2)`.
 */
import { util, type Rect } from 'fabric';
import type { Point, RectangleGeometry } from '@osdlabel/annotation';

/** Corners in the order top-left, top-right, bottom-right, bottom-left of the unrotated box. */
export type Corners = readonly [Point, Point, Point, Point];

/** Builds a rectangle geometry. */
export function rectangle(
  origin: Point,
  width: number,
  height: number,
  rotation: number,
): RectangleGeometry {
  return { type: 'rectangle', origin, width, height, rotation };
}

/** cos and sin of an angle in degrees, exact at multiples of 90. */
function cosSinDegrees(degrees: number): readonly [number, number] {
  const quarterTurns = degrees / 90;
  if (Number.isInteger(quarterTurns)) {
    switch (((quarterTurns % 4) + 4) % 4) {
      case 0:
        return [1, 0];
      case 1:
        return [0, 1];
      case 2:
        return [-1, 0];
      default:
        return [0, -1];
    }
  }
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/**
 * Rotate `point` about `pivot` by `degrees`, clockwise on screen (image y
 * points down), so +90 takes the +x axis onto +y.
 */
export function rotateAbout(point: Point, pivot: Point, degrees: number): Point {
  const [cos, sin] = cosSinDegrees(degrees);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

/**
 * The contract's corners: the four corners of the unrotated box, each turned
 * about the box's centre.
 */
export function referenceCorners(shape: RectangleGeometry): Corners {
  const { origin, width, height, rotation } = shape;
  const centre = { x: origin.x + width / 2, y: origin.y + height / 2 };
  return [
    rotateAbout({ x: origin.x, y: origin.y }, centre, rotation),
    rotateAbout({ x: origin.x + width, y: origin.y }, centre, rotation),
    rotateAbout({ x: origin.x + width, y: origin.y + height }, centre, rotation),
    rotateAbout({ x: origin.x, y: origin.y + height }, centre, rotation),
  ];
}

/**
 * Where Fabric paints a `Rect`'s outline, excluding the stroke: `Rect._render`
 * draws `-width/2 … width/2` by `-height/2 … height/2` in the object's own
 * plane, and `calcTransformMatrix()` is the transform it renders that plane
 * with (position by origin, angle, scale, flip). The corners are in the order
 * of that local box, so a flipped `Rect` lists them in a different order than
 * its geometry does: compare those with {@link cornerSetDeviation}.
 *
 * `getCoords()` / `aCoords` would include the stroke, which is why this reads
 * the matrix instead.
 */
export function paintedCorners(rect: Rect): Corners {
  const matrix = rect.calcTransformMatrix();
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const at = (x: number, y: number): Point => {
    const p = util.transformPoint({ x, y }, matrix);
    return { x: p.x, y: p.y };
  };
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** The mean of the four corners: the centre of the painted shape. */
export function cornersCentre(corners: Corners): Point {
  return {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
    y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
  };
}

/** Area and perimeter of the parallelogram the corners span, from its edge vectors. */
export function cornersAreaAndPerimeter(corners: Corners): {
  readonly area: number;
  readonly perimeter: number;
} {
  const ax = corners[1].x - corners[0].x;
  const ay = corners[1].y - corners[0].y;
  const bx = corners[3].x - corners[0].x;
  const by = corners[3].y - corners[0].y;
  return {
    area: Math.abs(ax * by - ay * bx),
    perimeter: 2 * (Math.hypot(ax, ay) + Math.hypot(bx, by)),
  };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Largest distance between corresponding corners, in order. */
export function cornerDeviation(actual: Corners, expected: Corners): number {
  return Math.max(...actual.map((p, i) => distance(p, expected[i]!)));
}

const PERMUTATIONS: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  const permute = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) out.push(prefix);
    rest.forEach((n, i) => permute([...prefix, n], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  permute([], [0, 1, 2, 3]);
  return out;
})();

/**
 * Largest distance between the two sets of corners under the best pairing:
 * the same four points in any order. For a flipped `Rect`, whose local
 * top-left is painted on the other side.
 */
export function cornerSetDeviation(actual: Corners, expected: Corners): number {
  return Math.min(
    ...PERMUTATIONS.map((perm) =>
      Math.max(...perm.map((j, i) => distance(actual[i]!, expected[j]!))),
    ),
  );
}

/** Corners as text, for assertion messages. */
export function formatCorners(corners: Corners): string {
  return corners.map((p) => `(${p.x}, ${p.y})`).join(' ');
}

/** The contract's worked example, at a given rotation. */
export const workedExample = (rotation: number): RectangleGeometry =>
  rectangle({ x: 200, y: 100 }, 100, 50, rotation);

/** Rotations every property is checked at, in degrees. */
export const RECTANGLE_ROTATIONS = [0, 15, 30, 45, 90, 135, 180, -30, 270, 359.5] as const;

/**
 * Fractional, negative and large origins. Every value, and every centre
 * `origin + size / 2` with the sizes below, has at most four decimals, so
 * `toObject()`'s rounding to four decimals leaves it as it is.
 */
export const RECTANGLE_ORIGINS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 200, y: 100 },
  { x: -37.25, y: 12.5 },
  { x: 0.3, y: -0.7 },
  { x: 1234.567, y: 8910.11 },
];

/** Tiny, ordinary, very elongated and large sizes, as `[width, height]`. */
export const RECTANGLE_SIZES: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [100, 50],
  [33.25, 1200.5],
  [5000, 0.75],
  [5000, 3000],
];

/** Every combination of the origins, sizes and rotations above. */
export function rectangleMatrix(): readonly RectangleGeometry[] {
  const out: RectangleGeometry[] = [];
  for (const rotation of RECTANGLE_ROTATIONS) {
    for (const origin of RECTANGLE_ORIGINS) {
      for (const [width, height] of RECTANGLE_SIZES) {
        out.push(rectangle(origin, width, height, rotation));
      }
    }
  }
  return out;
}

/** A rectangle as text, for assertion messages. */
export function describeRectangle(r: RectangleGeometry): string {
  return `origin (${r.origin.x}, ${r.origin.y}) ${r.width}x${r.height} rotation ${r.rotation}`;
}
