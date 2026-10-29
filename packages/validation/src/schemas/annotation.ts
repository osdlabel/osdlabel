import * as v from 'valibot';
import type { GeometryType } from '@osdlabel/annotation';
import { GeometrySchema } from './geometry.js';
import { ToolTypeSchema } from './tool.js';
import { FabricRawAnnotationDataSchema } from './fabric-data.js';

/**
 * Schema for {@link @osdlabel/annotation!BaseAnnotation | BaseAnnotation} — validates core annotation fields.
 * Extension fields (contextId, rawAnnotationData, etc.) are not checked here;
 * they pass through via v.looseObject behavior inherited by intersections.
 */
export const BaseAnnotationSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  geometry: GeometrySchema,
  toolType: ToolTypeSchema,
  label: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.unknown())),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Schema for the fields {@link osdlabel!OsdAnnotation | OsdAnnotation} adds to a base annotation. */
export const OsdFieldsSchema = v.object({
  imageId: v.pipe(v.string(), v.minLength(1)),
  contextId: v.pipe(v.string(), v.minLength(1)),
  rawAnnotationData: FabricRawAnnotationDataSchema,
});

/**
 * The Fabric class that paints each geometry type, as a saved payload's `type`
 * names it. A point is painted as a small circle. Every release has saved
 * these spellings (Fabric 7's `toObject()`); Fabric also revives a class by
 * its lowercase name, so the comparison ignores case, as the payload schema's
 * own type check does.
 */
const PAINTED_BY = {
  rectangle: 'Rect',
  circle: 'Circle',
  point: 'Circle',
  line: 'Line',
  polyline: 'Polyline',
  polygon: 'Polygon',
} as const satisfies Record<GeometryType, string>;

/** The part of a structurally valid annotation the cross-field check reads. */
interface PaintedAnnotation {
  readonly id: string;
  readonly geometry: { readonly type: GeometryType };
  readonly rawAnnotationData: { readonly data: { readonly type: string } };
}

function paintsItsGeometry(annotation: PaintedAnnotation): boolean {
  const expected = PAINTED_BY[annotation.geometry.type];
  return annotation.rawAnnotationData.data.type.toLowerCase() === expected.toLowerCase();
}

function paintMismatchMessage(annotation: PaintedAnnotation): string {
  const { id, geometry, rawAnnotationData } = annotation;
  return (
    `Annotation "${id}" has ${geometry.type} geometry, but its rawAnnotationData ` +
    `is a Fabric ${rawAnnotationData.data.type}, not a ${PAINTED_BY[geometry.type]}`
  );
}

/**
 * Schema for a whole {@link osdlabel!OsdAnnotation | OsdAnnotation}, as
 * `deserialize` validates each entry of a document: the base fields, the OSD
 * fields, and that the two halves describe the same kind of shape.
 *
 * An annotation stores its shape twice. `rawAnnotationData` is the saved
 * Fabric object, and it is what is painted. `geometry` is what is measured,
 * labelled and exported. Editing the shape on the canvas recomputes the
 * geometry from the Fabric object. So the payload must be the Fabric class
 * that paints the geometry's type: `Rect` for a rectangle, `Circle` for a
 * circle or a point, `Line`, `Polyline` and `Polygon` for the others. An
 * annotation whose payload is another class (rectangle geometry with a
 * `Circle` payload, say) is rejected with an issue naming the annotation and
 * both types. Accepted, it would measure a shape nobody sees, and an edit to
 * the shape that is seen would be dropped, or would change the geometry's
 * type.
 *
 * Only the kind is compared. Whether the payload sits where the geometry says
 * cannot be checked without Fabric, so it is not.
 */
export const OsdAnnotationSchema = v.pipe(
  v.intersect([BaseAnnotationSchema, OsdFieldsSchema]),
  v.check(
    (annotation) => paintsItsGeometry(annotation),
    (issue) => paintMismatchMessage(issue.input),
  ),
);
