import * as v from 'valibot';
import { GeometrySchema } from './geometry.js';
import { ToolTypeSchema } from './tool.js';
import { FabricRawAnnotationDataSchema } from './fabric-data.js';

/**
 * Schema for @see {@link import("@osdlabel/annotation/annotation").BaseAnnotation} — validates core annotation fields.
 * Extension fields (contextId, rawAnnotationData, etc.) are not checked here;
 * they pass through via v.looseObject behavior inherited by intersections.
 */
export const BaseAnnotationSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  imageId: v.pipe(v.string(), v.minLength(1)),
  geometry: GeometrySchema,
  toolType: ToolTypeSchema,
  label: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.unknown())),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Schema for @see {@link import("osdlabel").OsdAnnotation} - validates fields added by the Annotator. */
export const OsdFieldsSchema = v.object({
  contextId: v.pipe(v.string(), v.minLength(1)),
  rawAnnotationData: FabricRawAnnotationDataSchema,
});

export const OsdAnnotationSchema = v.intersect([BaseAnnotationSchema, OsdFieldsSchema]);
