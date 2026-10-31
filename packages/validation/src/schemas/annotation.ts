import * as v from 'valibot';
import { MASK_RAW_FORMAT } from '@osdlabel/annotation';
import { GeometrySchema } from './geometry.js';
import { ToolTypeSchema } from './tool.js';
import { FabricRawAnnotationDataSchema } from './fabric-data.js';
import { MaskRawAnnotationDataSchema } from './mask-data.js';

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
  // Vector annotations carry a serialized Fabric object; masks carry pixels.
  rawAnnotationData: v.variant('format', [
    FabricRawAnnotationDataSchema,
    MaskRawAnnotationDataSchema,
  ]),
});

/**
 * Schema for a whole {@link osdlabel!OsdAnnotation | OsdAnnotation}.
 *
 * A mask geometry with a Fabric payload (or the reverse) passes both halves
 * separately and fails only when rendered, one annotation at a time; it is a
 * malformed document, and is refused here like any other schema violation.
 */
export const OsdAnnotationSchema = v.pipe(
  v.intersect([BaseAnnotationSchema, OsdFieldsSchema]),
  v.check(
    (a) => (a.geometry.type === 'mask') === (a.rawAnnotationData.format === MASK_RAW_FORMAT),
    'A mask geometry needs a mask payload, and a vector geometry a Fabric one',
  ),
);
