import * as v from 'valibot';

/** Schema for {@link @osdlabel/annotation!ToolType | ToolType}. */
export const ToolTypeSchema = v.union([
  v.literal('rectangle'),
  v.literal('circle'),
  v.literal('line'),
  v.literal('point'),
  v.literal('polyline'),
  v.literal('freeHandPath'),
  v.literal('segmentationBrush'),
]);
