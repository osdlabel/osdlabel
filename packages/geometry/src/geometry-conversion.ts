import type { CircleGeometry, RectangleGeometry } from '@osdlabel/annotation';
import { boundingBox } from './geometry-math.js';

/**
 * Convert a circle to its axis-aligned bounding-box rectangle.
 *
 * The resulting rectangle's `origin` is the bounding box's top-left corner,
 * its `width`/`height` span the circle's diameter, and `rotation` is `0`.
 */
export function circleToBoundingRectangle(circle: CircleGeometry): RectangleGeometry {
  const { min, max } = boundingBox(circle);
  return {
    type: 'rectangle',
    origin: { x: min.x, y: min.y },
    width: max.x - min.x,
    height: max.y - min.y,
    rotation: 0,
  };
}
