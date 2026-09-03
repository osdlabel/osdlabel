/**
 * Bounds constants for validation schemas.
 */

export const MAX_COORDINATE = 1_000_000;
export const MAX_DIMENSION = 1_000_000;
export const MAX_SCALE = 1_000;
export const MAX_ANGLE = 360;
export const MAX_STROKE_WIDTH = 10_000;
export const MAX_STRING_LENGTH = 256;
export const MAX_POINTS_COUNT = 10_000;
export const MAX_STROKE_DASH_ARRAY_LENGTH = 20;
/**
 * Upper bound on every image-space quantity a mask records: the image's own
 * sides, the mask box's sides, and the box's placement.
 *
 * One bound for all four, deliberately. Anything tighter on the mask's own box
 * or origin rejects masks the annotator can produce: a 9x9 dab in the corner
 * of a 1200000x900000 slide, or a 1047993x3 box spanning two far-apart dabs —
 * both well inside {@link MAX_MASK_PIXELS}. Such a mask is written happily by
 * `serialize` and then refused by `deserialize`, and refused as a *schema*
 * failure, which throws and takes every other annotation in the document with
 * it rather than landing in `skipped`. Deep-zoom images are the case this
 * feature exists for.
 *
 * The real limit on a mask is its area — {@link MAX_MASK_PIXELS}, checked as a
 * product — not any single side.
 *
 * 2^26 a side puts the largest expressible image at 2^52 pixels, inside the
 * range where a pixel index is still an exact integer — which is what the COCO
 * decoder needs to walk it. Real whole-slide images are ~200000 a side.
 */
export const MAX_IMAGE_DIMENSION = 2 ** 26;
/**
 * Upper bound on a mask's decoded area (width * height), mirroring
 * `DEFAULT_MAX_MASK_PIXELS` in `@osdlabel/mask`.
 *
 * Bounding the sides individually is not enough: two values well inside
 * {@link MAX_IMAGE_DIMENSION} still multiply into an allocation large enough
 * to exhaust memory, so the product is what has to be checked. It is also the
 * only bound a mask's box needs — see {@link MAX_IMAGE_DIMENSION}.
 */
export const MAX_MASK_PIXELS = 64 * 1024 * 1024;
/**
 * Upper bound on an encoded mask payload, **derived** from
 * {@link MAX_MASK_PIXELS} rather than chosen.
 *
 * A hand-picked value silently made `serialize` able to emit what `deserialize`
 * would refuse: the worst case is a mask whose every pixel alternates, giving
 * one single-byte run per pixel, which base64 expands by 4/3. A 3000x2100 mask
 * — a fifth of the pixel cap — already encodes to 8.4M characters. Tying the
 * two constants together means any mask inside the pixel cap round-trips, and
 * the string check stays a cheap early filter for payloads far outside it.
 */
export const MAX_MASK_COUNTS_LENGTH = Math.ceil((MAX_MASK_PIXELS * 4) / 3) + 4;
