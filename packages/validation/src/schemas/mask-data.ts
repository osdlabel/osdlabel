/**
 * Valibot schema for mask raw annotation data validation.
 */
import * as v from 'valibot';
import { MASK_RAW_FORMAT } from '@osdlabel/annotation';
import {
  MAX_IMAGE_DIMENSION,
  MAX_MASK_COUNTS_LENGTH,
  MAX_MASK_DOWNSAMPLE,
  MAX_MASK_PIXELS,
  MAX_STRING_LENGTH,
} from './constants.js';

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
 * Image pixels per mask cell: a power of two from 1 to
 * {@link MAX_MASK_DOWNSAMPLE}. Shared with the geometry schema.
 */
export const MaskDownsampleSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(MAX_MASK_DOWNSAMPLE),
  v.check((d) => (d & (d - 1)) === 0, 'Mask downsample must be a power of two'),
);

/** Cells in a box of image pixels at a downsample: what a decode allocates. */
function cellArea(width: number, height: number, downsample: number | undefined): number {
  const d = downsample ?? 1;
  return Math.ceil(width / d) * Math.ceil(height / d);
}

/**
 * A schema for MaskRawAnnotationData — the pixel payload of a mask annotation.
 *
 * `counts` is opaque encoded data, so it is bounded by length rather than
 * parsed here — decoding is the codec's job. The codecs guard their own
 * allocations (see `assertDecodableArea` in `@osdlabel/mask`), because a
 * payload can reach a decoder before it reaches this schema: `deserialize`
 * converts foreign mask formats to canonical *first*, then validates.
 *
 * The box is bounded by {@link MAX_MASK_PIXELS} **cells**: a downsampled mask
 * allocates its cell grid, not its image-pixel box. Moving this bound out of
 * the schema waits for the cap to be raised (#155); until then osdlabel's own
 * reader skips an over-cap mask before validation, so it costs that mask and
 * never the document.
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
      fill: v.optional(v.pipe(v.string(), v.maxLength(MAX_STRING_LENGTH))),
      // Without this entry `v.object` would strip the field, and the payload
      // would then fail to decode as a full-resolution one.
      downsample: v.optional(MaskDownsampleSchema),
    }),
    // Cells, not image pixels: the cap bounds what a decode allocates, and a
    // downsampled mask allocates its cell grid.
    v.check(
      (d) => cellArea(d.width, d.height, d.downsample) <= MAX_MASK_PIXELS,
      `Mask box must not exceed ${MAX_MASK_PIXELS} cells`,
    ),
  ),
});
