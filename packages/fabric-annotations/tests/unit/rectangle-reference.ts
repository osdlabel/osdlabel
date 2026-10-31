/**
 * Part of the rectangle suite (every test file with "rectangle" in its name).
 *
 * The test oracle for rectangles in this package: where a `RectangleGeometry`'s
 * corners are, computed independently of the library, and where Fabric
 * actually paints a `Rect`. The suite's invariant is that the two agree. It
 * also holds the package's one matrix of rotations, positions and sizes that
 * the rectangle tests run over.
 *
 * `referenceCorners` deliberately does not share code or formulation with
 * `rectangleCorners` in `@osdlabel/geometry` (which this package does not
 * depend on anyway): it rotates the four corners of the unrotated box about
 * its centre, rather than offsetting from the centre by `(±w/2, ±h/2)`, and it
 * uses exact values at quarter turns so the worked example can be pinned with
 * `toEqual`. It is itself pinned to the hand-computed worked example in
 * `rectangle-fabric.test.ts`.
 */
import { util, type Rect } from 'fabric';
import type { Point, RectangleGeometry } from '@osdlabel/annotation';

/** Corners in the order top-left, top-right, bottom-right, bottom-left of the unrotated box. */
export type Corners = readonly [Point, Point, Point, Point];

/** The fields of a rectangle geometry that determine its shape. */
export type RectangleShape = Pick<RectangleGeometry, 'origin' | 'width' | 'height' | 'rotation'>;

/** Builds a rectangle geometry. */
export function rectangle(
  origin: Point,
  width: number,
  height: number,
  rotation: number,
): RectangleGeometry {
  return { type: 'rectangle', origin, width, height, rotation };
}

/** Rotations every property is checked at, in degrees. */
export const ROTATIONS = [0, 15, 30, 45, 90, 135, 180, -30, 270, 359.5] as const;

/** Fractional, negative and large positions. */
export const POSITIONS: readonly Point[] = [
  { x: 0.25, y: 0.75 },
  { x: 123.456, y: 789.012 },
  { x: -37.5, y: 4096.125 },
  // Drawn with the mouse: image coordinates carry many decimals.
  { x: 132.38578680202863, y: 218.61252115058915 },
];

/** Tiny, ordinary, very elongated and large sizes. */
export const SIZES: readonly { readonly width: number; readonly height: number }[] = [
  { width: 0.5, height: 0.5 },
  { width: 1, height: 3.75 },
  { width: 100, height: 50 },
  { width: 5000, height: 0.5 },
  { width: 4999.75, height: 5000 },
];

/** Every position × size at `rotation`. */
export function matrixAt(rotation: number): RectangleGeometry[] {
  return POSITIONS.flatMap((origin) =>
    SIZES.map(({ width, height }) => rectangle(origin, width, height, rotation)),
  );
}

/** A rectangle as text, for assertion messages. */
export function label(shape: RectangleShape): string {
  return `origin (${shape.origin.x}, ${shape.origin.y}) ${shape.width}×${shape.height} at ${shape.rotation}°`;
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
 * The contract: the box `origin` to `origin + (width, height)`, turned
 * `rotation` degrees clockwise about its own centre.
 */
export function referenceCorners(shape: RectangleShape): Corners {
  const { origin, width, height, rotation } = shape;
  const centre = { x: origin.x + width / 2, y: origin.y + height / 2 };
  const unrotated: Corners = [
    { x: origin.x, y: origin.y },
    { x: origin.x + width, y: origin.y },
    { x: origin.x + width, y: origin.y + height },
    { x: origin.x, y: origin.y + height },
  ];
  return [
    rotateAbout(unrotated[0], centre, rotation),
    rotateAbout(unrotated[1], centre, rotation),
    rotateAbout(unrotated[2], centre, rotation),
    rotateAbout(unrotated[3], centre, rotation),
  ];
}

/**
 * Where Fabric paints a `Rect`'s outline, excluding the stroke: `Rect._render`
 * draws `-width/2 … width/2` by `-height/2 … height/2` in the object's own
 * plane, and `calcTransformMatrix()` is the transform Fabric renders it with
 * (position by origin, angle, scale, flip, skew). Corners are in the order of
 * that local box (top-left, top-right, bottom-right, bottom-left before the
 * transform), so a flipped `Rect` lists them in a different order than its
 * geometry does: compare those with {@link cornerSetDeviation}.
 *
 * `getCoords()` / `aCoords` would include the stroke (and `padding`), which is
 * why this reads the matrix instead.
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

/** The box dragged from `a` to `b`, in reference-corner order. */
export function dragBoxCorners(a: Point, b: Point): Corners {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
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
 * the same four points in any order. For shapes whose corner order differs
 * (a flipped `Rect`, whose local top-left is painted on the other side).
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

/** A deterministic PRNG (mulberry32), so a sweep fails the same way every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
