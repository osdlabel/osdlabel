/**
 * Valibot schema for mask raw annotation data validation.
 */
import * as v from 'valibot';
import { MASK_RAW_FORMAT } from '@osdlabel/annotation';
import { MAX_IMAGE_DIMENSION, MAX_MASK_COUNTS_LENGTH, MAX_MASK_PIXELS } from './constants.js';

const FiniteNumber = v.pipe(v.number(), v.finite());
/**
 * The box's placement, its sides, and the image's sides all share one bound.
 *
 * A mask's box lives in image space, so anything tighter than the image bound
 * refuses masks the brush can paint — and refuses them here, as a schema
 * failure that costs the whole document. The bound that actually matters is
 * the area check below.
 *
 * The lower bound stays negative rather than 0: a box outside its image is
 * caught by `assertBoxInsideImage` at decode, which skips that one mask.
 * Rejecting it here instead would upgrade a per-annotation skip into a
 * document-wide throw.
 */
const Coordinate = v.pipe(
  FiniteNumber,
  v.minValue(-MAX_IMAGE_DIMENSION),
  v.maxValue(MAX_IMAGE_DIMENSION),
);
const Dimension = v.pipe(FiniteNumber, v.minValue(0), v.maxValue(MAX_IMAGE_DIMENSION));

/**
 * A schema for MaskRawAnnotationData — the pixel payload of a mask annotation.
 *
 * `counts` is opaque encoded data, so it is bounded by length rather than
 * parsed here — decoding is the codec's job. The codecs guard their own
 * allocations (see `assertDecodableArea` in `@osdlabel/mask`), because a
 * payload can reach a decoder before it reaches this schema: `deserialize`
 * converts foreign mask formats to canonical *first*, then validates.
 */
export const MaskRawAnnotationDataSchema = v.object({
  format: v.literal(MASK_RAW_FORMAT),
  data: v.pipe(
    v.object({
      x: Coordinate,
      y: Coordinate,
      width: Dimension,
      height: Dimension,
      imageWidth: Dimension,
      imageHeight: Dimension,
      counts: v.pipe(v.string(), v.maxLength(MAX_MASK_COUNTS_LENGTH)),
      fill: v.optional(v.string()),
    }),
    v.check(
      (d) => d.width * d.height <= MAX_MASK_PIXELS,
      `Mask area must not exceed ${MAX_MASK_PIXELS} pixels`,
    ),
  ),
});
