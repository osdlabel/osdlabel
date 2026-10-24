import type { Point } from '@osdlabel/annotation';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Centre of a rectangle whose geometry records its rotated top-left corner
 * (`origin`), as `centroid` in `@osdlabel/geometry` computes it.
 *
 * Fabric 7 positions an object by its centre unless an origin is set, so
 * rectangles are built and read by their centre: unlike a top-left origin,
 * the centre does not move with the stroke width.
 */
export function rectangleCenter(
  origin: Point,
  width: number,
  height: number,
  rotation: number,
): Point {
  const theta = rotation * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: origin.x + (width / 2) * cos - (height / 2) * sin,
    y: origin.y + (width / 2) * sin + (height / 2) * cos,
  };
}

/** Inverse of {@link rectangleCenter}: the rotated top-left corner from the centre. */
export function rectangleOrigin(
  center: Point,
  width: number,
  height: number,
  rotation: number,
): Point {
  const theta = rotation * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: center.x - (width / 2) * cos + (height / 2) * sin,
    y: center.y - (width / 2) * sin - (height / 2) * cos,
  };
}
