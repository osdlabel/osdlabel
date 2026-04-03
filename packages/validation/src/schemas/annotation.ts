import * as v from 'valibot';
import { GeometrySchema } from './geometry.js';

/** Schema for @see {@link import("@osdlabel/annotation/annotation-tools").ToolType} */
export const ToolTypeSchema = v.union([
  v.literal('rectangle'),
  v.literal('circle'),
  v.literal('line'),
  v.literal('point'),
  v.literal('polyline'),
  v.literal('freeHandPath'),
]);

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
