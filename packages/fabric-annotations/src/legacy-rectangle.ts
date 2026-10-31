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
 * their centre. Nothing in the library calls it: a host that wants stored
 * rectangles' geometry corrected calls it on each annotation it loads.
 *
 * Releases up to 0.21.0 built a rectangle with its top-left corner as
 * `left`/`top` but no origin, so under Fabric 7's default centre origin it
 * was painted centred on that point, and its geometry's `origin` was read
 * back from `left`/`top`: the centre it was painted at. On a rectangle never
 * edited, that point is also the top-left corner of the user's drag; after a
 * move, resize or rotation it is only the centre. Its saved Fabric data still
 * paints where the user saw it, so that is kept, and the geometry is
 * recomputed from it: measurements, labels and exports then describe the
 * rectangle on screen.
 *
 * Such a rectangle is recognised by a centre origin whose `left`/`top` match
 * the geometry's origin, to within the rounding `toObject()` applied. A
 * current one keeps its centre there and its origin in the geometry, half its
 * size apart, so it can only match when it is a few hundredths of a pixel
 * across; its origin is then recomputed from where it is painted, which is
 * where it already is. Anything else is returned unchanged, as the same object.
 *
 * It lives in its own module, so a bundle that never imports it does not
 * carry it; it is also importable on its own as
 * `@osdlabel/fabric-annotations/legacy-rectangle`.
 *
 * @example
 * ```ts
 * const { byImage } = deserialize(doc);
 * for (const annotations of Object.values(byImage)) {
 *   for (const annotation of Object.values(annotations)) {
 *     annotations[annotation.id] = migrateLegacyRectangle(annotation);
 *   }
 * }
 * actions.loadAnnotations(byImage);
 * ```
 */
export function migrateLegacyRectangle<A extends Annotation<FabricFields>>(annotation: A): A {
  const { geometry, rawAnnotationData: raw } = annotation;
  if (geometry.type !== 'rectangle' || raw?.format !== 'fabric') return annotation;
  const { data } = raw;
  if (!isCentreOrigin(data.originX) || !isCentreOrigin(data.originY)) return annotation;
  const { left, top } = data;
  if (!isNear(left, geometry.origin.x) || !isNear(top, geometry.origin.y)) return annotation;
  // The saved left/top is the centre it is painted at.
  const origin = rectangleOrigin({ x: left, y: top }, geometry.width, geometry.height);
  if (origin.x === geometry.origin.x && origin.y === geometry.origin.y) return annotation;
  return { ...annotation, geometry: { ...geometry, origin } } as A;
}
