import type { Annotation, AnnotationId } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import { OsdAnnotationSchema } from '@osdlabel/validation';
import type { OsdFields } from './types.js';
import * as v from 'valibot';

/** Error type for serialization/deserialization failures */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/** Result of deserializing an annotation array */
export interface DeserializeResult<E extends object = Record<never, never>> {
  readonly byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>>;
}

/** Serialize OSD annotation state into a flat array of annotations */
export function serialize(state: AnnotationState<OsdFields>): Annotation<OsdFields>[] {
  return getAllAnnotationsFlat(state);
}

/**
 * Validate a document (a flat annotation array, as {@link serialize} returns
 * it) and group it by image, the shape `loadAnnotations` takes.
 *
 * Each annotation is checked with `OsdAnnotationSchema` from
 * `@osdlabel/validation`: its base fields, `imageId`, `contextId`, its saved
 * Fabric object in `rawAnnotationData`, that the saved object is the
 * Fabric class that paints its geometry's type (`Rect` for a rectangle,
 * `Circle` for a circle or a point, `Line`, `Polyline`, `Polygon`), and that
 * its `toolType` is a tool that draws that type (the tool of the same name for
 * a rectangle, circle, line or point, `polyline` or `freeHandPath` for a
 * polyline or a polygon). Constraints count annotations by `toolType`, so an
 * annotation recorded under another tool would count against that tool's
 * limit. If any annotation fails, nothing is returned: it throws a
 * {@link SerializationError} whose message names the first problem. For a
 * payload of the wrong class, that is the annotation's id, its geometry type,
 * the class it holds and the class it needs; for a `toolType` that does not
 * draw its geometry, the annotation's id, its geometry type, its `toolType`
 * and the tool types that draw it.
 *
 * An annotation stores its shape twice, and each field is authoritative for
 * something different:
 *
 * - `rawAnnotationData` is what is painted, and what the user drags.
 * - `geometry` is what is measured, labelled and exported.
 * - Editing the shape recomputes `geometry` from the edited Fabric object.
 *
 * Only their kind is compared here. Whether the payload sits where the
 * geometry says needs Fabric to answer, so it is not checked, and an
 * annotation whose two fields disagree in place loads as saved: it is painted
 * from its payload and measured from its geometry until its first edit.
 * Build annotations with `createAnnotationFromGeometry`, which writes both
 * from one geometry, rather than pairing them by hand.
 *
 * @throws {SerializationError} when `doc` is not a valid document.
 */
export function deserialize(doc: unknown): DeserializeResult<OsdFields> {
  let annotations: Annotation<OsdFields>[];
  try {
    annotations = v.parse(v.array(OsdAnnotationSchema), doc) as unknown as Annotation<OsdFields>[];
  } catch (err) {
    throw new SerializationError(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const byImage: Record<ImageId, Record<AnnotationId, Annotation<OsdFields>>> = {};
  for (const ann of annotations) {
    const existing = byImage[ann.imageId];
    if (existing) {
      existing[ann.id] = ann;
    } else {
      byImage[ann.imageId] = { [ann.id]: ann };
    }
  }

  return { byImage };
}
