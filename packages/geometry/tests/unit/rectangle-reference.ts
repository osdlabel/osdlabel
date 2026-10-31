// Part of the rectangle suite: an independent reference for where a
// RectangleGeometry's corners are, written without @osdlabel/geometry so the
// suite never checks the library against itself. It is pinned to the
// contract's worked example in rectangle-geometry.test.ts.
//
// The contract: origin/width/height are the box before rotation, covering
// origin to origin + (width, height). `rotation` (degrees, clockwise in image
// space where y points down, so +90 takes +x onto +y) turns that box about
// its own centre, origin + (width / 2, height / 2).
import type { Point, RectangleGeometry } from '@osdlabel/annotation';

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

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });

/**
 * The corners top-left, top-right, bottom-right, bottom-left of the unrotated
 * box, after the turn. Built by turning only the top-left corner about the
 * centre, then walking the turned edges: TL→TR is width·(cos θ, sin θ) and
 * TL→BL is height·(−sin θ, cos θ).
 */
export function referenceCorners(r: RectangleGeometry): Corners {
  const theta = (r.rotation / 180) * Math.PI;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const centre: Point = { x: r.origin.x + r.width / 2, y: r.origin.y + r.height / 2 };
  // The top-left corner relative to the centre, before the turn.
  const rx = -r.width / 2;
  const ry = -r.height / 2;
  const tl = add(centre, { x: rx * cos - ry * sin, y: rx * sin + ry * cos });
  const along: Point = { x: r.width * cos, y: r.width * sin };
  const down: Point = { x: -r.height * sin, y: r.height * cos };
  return [tl, add(tl, along), add(add(tl, along), down), add(tl, down)];
}

/** The contract's worked example, at a given rotation. */
export const workedExample = (rotation: number): RectangleGeometry =>
  rectangle({ x: 200, y: 100 }, 100, 50, rotation);

/** Rotations every property is checked at, in degrees. */
export const RECTANGLE_ROTATIONS = [0, 15, 30, 45, 90, 135, 180, -30, 270, 359.5] as const;

/** Fractional, negative and large origins. */
export const RECTANGLE_ORIGINS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 200, y: 100 },
  { x: -37.25, y: 12.5 },
  { x: 0.3, y: -0.7 },
  { x: 1234.567, y: 8910.11 },
];

/** Sizes from tiny to large, square and elongated both ways. */
export const RECTANGLE_SIZES: readonly { readonly width: number; readonly height: number }[] = [
  { width: 0.5, height: 0.5 },
  { width: 1, height: 3 },
  { width: 100, height: 50 },
  { width: 33.3, height: 77.7 },
  { width: 5000, height: 5000 },
  { width: 5000, height: 0.5 },
  { width: 0.5, height: 5000 },
];

/** Every origin × size, at one rotation, with a label for failure messages. */
export function rectangleMatrix(
  rotation: number,
): readonly { readonly label: string; readonly geometry: RectangleGeometry }[] {
  return RECTANGLE_ORIGINS.flatMap((origin) =>
    RECTANGLE_SIZES.map(({ width, height }) => ({
      label: `origin (${origin.x}, ${origin.y}) ${width}×${height} @ ${rotation}°`,
      geometry: rectangle(origin, width, height, rotation),
    })),
  );
}
