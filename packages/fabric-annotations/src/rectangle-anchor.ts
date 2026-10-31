import type { Point } from '@osdlabel/annotation';

/**
 * Centre of a rectangle, which its rotation turns it about: the centre of its
 * unrotated box, `origin` to `origin + (width, height)`, so it does not
 * depend on the rotation.
 *
 * Fabric 7 positions an object by its centre unless an origin is set, so
 * rectangles are built and read by their centre: unlike a top-left origin,
 * the centre does not move with the stroke width or the rotation.
 */
export function rectangleCenter(origin: Point, width: number, height: number): Point {
  return { x: origin.x + width / 2, y: origin.y + height / 2 };
}

/** Inverse of {@link rectangleCenter}: the unrotated box's top-left corner from its centre. */
export function rectangleOrigin(center: Point, width: number, height: number): Point {
  return { x: center.x - width / 2, y: center.y - height / 2 };
}
