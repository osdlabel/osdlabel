import type { Annotation } from '@osdlabel/annotation';
import type { FabricFields } from './types.js';
import { rectangleOrigin } from './rectangle-anchor.js';

/**
 * How far a saved `left`/`top` may sit from the geometry's origin and still
 * be the same number. Earlier releases stored the geometry unrounded but the
 * Fabric data through `toObject()`, which rounds to `config.NUM_FRACTION_DIGITS`
 * (4 by default, so within 5e-5); this allows a host that lowered it to 2.
 */
const SAVED_PRECISION = 1e-2;

/** Fabric 7's default origin is the centre; `0.5` is the same origin as a number. */
function isCentreOrigin(origin: unknown): boolean {
  return origin === undefined || origin === 'center' || origin === 0.5;
}

function isNear(saved: unknown, value: number): saved is number {
  return typeof saved === 'number' && Math.abs(saved - value) <= SAVED_PRECISION;
}

/**
 * Corrects the geometry of a rectangle saved before rectangles were placed by
 * their centre.
 *
 * Earlier releases built a rectangle with its top-left corner as `left`/`top`
 * but no origin, so under Fabric 7's default centre origin it was painted
 * centred on that corner, and its geometry recorded the corner it was meant
 * to have. Its saved Fabric data still paints where the user saw it, so that
 * is kept, and the geometry is recomputed from it: measurements, labels and
 * exports then describe the rectangle on screen.
 *
 * Such a rectangle is recognised by a centre origin whose `left`/`top` match
 * the geometry's origin, to within the rounding `toObject()` applied. A
 * current one keeps its centre there and its corner in the geometry, half its
 * diagonal apart, so it can only match when it is a few hundredths of a pixel
 * across; its corner is then recomputed from where it is painted, which is
 * where it already is. Anything else is returned unchanged, as the same object.
 */
export function migrateLegacyRectangle<A extends Annotation<FabricFields>>(annotation: A): A {
  const { geometry, rawAnnotationData: raw } = annotation;
  if (geometry.type !== 'rectangle' || raw?.format !== 'fabric') return annotation;
  const { data } = raw;
  if (!isCentreOrigin(data.originX) || !isCentreOrigin(data.originY)) return annotation;
  const { left, top } = data;
  if (!isNear(left, geometry.origin.x) || !isNear(top, geometry.origin.y)) return annotation;
  // The saved left/top is the centre it is painted at.
  const origin = rectangleOrigin(
    { x: left, y: top },
    geometry.width,
    geometry.height,
    geometry.rotation,
  );
  if (origin.x === geometry.origin.x && origin.y === geometry.origin.y) return annotation;
  return { ...annotation, geometry: { ...geometry, origin } } as A;
}
