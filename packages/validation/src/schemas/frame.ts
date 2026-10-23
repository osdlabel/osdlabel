import * as v from 'valibot';
import { MAX_STRING_LENGTH } from './constants.js';

/** Upper bound on a frame index: generous for any stack, cine loop or video. */
export const MAX_FRAME_INDEX = 10_000_000;

/**
 * Schema for a `FrameRef` (declared in `@osdlabel/frame`, which this package
 * may not import). `osdlabel` asserts at compile time that the two agree.
 */
export const FrameRefSchema = v.object({
  index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_FRAME_INDEX)),
  key: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_STRING_LENGTH))),
  time: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
});
