import * as v from 'valibot';

/** Schema for @see {@link import("@osdlabel/annotation/annotation-tools").ToolType} */
export const ToolTypeSchema = v.union([
  v.literal('rectangle'),
  v.literal('circle'),
  v.literal('line'),
  v.literal('point'),
  v.literal('polyline'),
  v.literal('freeHandPath'),
  v.literal('segmentation'),
]);
