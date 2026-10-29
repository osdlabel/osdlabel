import type { Annotation } from '@osdlabel/annotation';
import type { FabricFields } from './types.js';
import { rectangleOrigin } from './rectangle-anchor.js';

/** Fabric 7's default origin is the centre; `0.5` is the same origin as a number. */
function isCentreOrigin(origin: unknown): boolean {
  return origin === undefined || origin === 'center' || origin === 0.5;
}

/**
 * Corrects the geometry of a rectangle saved before rectangles were placed by
 * their centre.
 *
 * Earlier releases built a rectangle with its top-left corner as `left`/`top`
 * but no origin, so under Fabric 7's default centre origin it was painted
 * centred on that corner, and its geometry recorded the corner it was meant
 * to have. Its saved Fabric data still paints where the user saw it, so that
 * is kept, and the geometry is recomputed to match it: measurements, labels
 * and exports then describe the rectangle on screen.
 *
 * Such a rectangle is recognised by a centre origin whose `left`/`top` equal
 * the geometry's origin. A current one keeps its centre there and its corner
 * in the geometry, so the two differ unless it has no size, when both
 * readings agree. Anything else is returned unchanged, as the same object.
 */
export function migrateLegacyRectangle<A extends Annotation<FabricFields>>(annotation: A): A {
  const { geometry, rawAnnotationData: raw } = annotation;
  if (geometry.type !== 'rectangle' || raw?.format !== 'fabric') return annotation;
  const { data } = raw;
  if (!isCentreOrigin(data.originX) || !isCentreOrigin(data.originY)) return annotation;
  if (data.left !== geometry.origin.x || data.top !== geometry.origin.y) return annotation;
  const origin = rectangleOrigin(
    geometry.origin,
    geometry.width,
    geometry.height,
    geometry.rotation,
  );
  if (origin.x === geometry.origin.x && origin.y === geometry.origin.y) return annotation;
  return { ...annotation, geometry: { ...geometry, origin } } as A;
}
