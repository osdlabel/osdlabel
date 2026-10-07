import { DEFAULT_MAX_MASK_PIXELS } from './bounded-dense-mask-buffer.js';
import { MaskCapacityExceededError } from './mask-buffer.js';

/**
 * Rejects mask dimensions that would allocate more than `maxPixels`.
 *
 * Decoders read dimensions straight out of a payload that typically came from
 * disk or the network. Without this, a document claiming a 1e6 x 1e6 mask turns
 * into an out-of-memory crash inside a typed-array constructor, several frames
 * away from the code that trusted it. Failing here keeps the error attributable
 * and recoverable.
 */
/**
 * Rejects dimensions that are not whole, non-negative pixel counts.
 *
 * Dimensions index typed arrays and bound loops. A fractional value produces
 * fractional indices, which read `undefined` and write nowhere while the
 * surrounding bookkeeping carries on — corruption that stays plausible-looking
 * rather than failing. A negative one makes an area that no allocation cap can
 * catch, because the product comes out small or positive. Nothing legitimate
 * produces either: masks are pixels.
 *
 * Separate from {@link assertDecodableArea} because encoding has to make the
 * same demand without imposing that function's allocation cap — the buffer's
 * `maxPixels` is configurable, and encoding what a host was allowed to paint
 * is not the place to second-guess it.
 */
export function assertPixelDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`Mask dimensions must be non-negative integers, got ${width}x${height}`);
  }
}

export function assertDecodableArea(width: number, height: number, maxPixels?: number): void {
  assertPixelDimensions(width, height);
  const cap = maxPixels ?? DEFAULT_MAX_MASK_PIXELS;
  const area = width * height;
  if (area > cap) throw new MaskCapacityExceededError(area, cap);
}

/**
 * Rejects an image whose pixel count cannot be counted exactly.
 *
 * A COCO decode walks a running index across the *whole image*, so the image's
 * area — which the payload states about itself, and which is far larger than
 * any mask inside it — bounds that walk. Past `Number.MAX_SAFE_INTEGER` the
 * increment stops advancing: `i + 1 === i` in float64, and the loop never
 * terminates. Below it the increment is always exact, so this is the precise
 * condition rather than a chosen margin.
 *
 * Nothing real comes close: the largest whole-slide images are ~1e10 pixels,
 * five orders of magnitude under this. The side bound below implies it, and is
 * the check that actually runs.
 */
export function assertCountableImage(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`Image dimensions must be non-negative integers, got ${width}x${height}`);
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw new RangeError(`Image of ${width}x${height} exceeds ${MAX_IMAGE_SIDE} pixels a side`);
  }
}

/**
 * The longest side an image a mask records may have: 2^26.
 *
 * The product bound alone (`Number.MAX_SAFE_INTEGER`, see
 * {@link assertCountableImage}) admitted a 2^26+10 x 100 image that the
 * validation schema then refused, so `serialize` could write a document
 * `deserialize` threw on. One side bound, applied at encode and decode here and
 * as `MAX_IMAGE_DIMENSION` in `@osdlabel/validation`, keeps the two in step;
 * `osdlabel` asserts at compile time that they agree. It puts the largest
 * image at 2^52 pixels, inside the exactly-countable range the COCO decoder
 * needs. Real whole-slide images are ~200000 a side.
 */
export const MAX_IMAGE_SIDE = 67_108_864 as const;

/**
 * Rejects a mask whose origin is not on the pixel grid.
 *
 * Separate from {@link assertDecodableArea} because a snapshot's placement is
 * validated in different places from its size, but the reason is the same: a
 * fractional coordinate becomes a fractional array index.
 */
export function assertDecodableOrigin(x: number, y: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`Mask origin must be integer pixel coordinates, got (${x}, ${y})`);
  }
}

/**
 * Rejects a mask whose bounding box does not fit inside its own image.
 *
 * Nothing this package produces can violate it — the buffer clips every write
 * to the image — so a payload that does is corrupt, and admitting it destroys
 * data rather than merely rendering oddly: `fromSnapshot` sizes the buffer from
 * the recorded image and clips the overhang away, so the first stroke that
 * refines such a mask silently commits a truncated version of it. A 20x20 mask
 * recorded against a 10x10 image loses three quarters of itself to a one-pixel
 * dab, with no error and nothing in `skipped`.
 */
export function assertBoxInsideImage(
  x: number,
  y: number,
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
): void {
  if (x < 0 || y < 0 || x + width > imageWidth || y + height > imageHeight) {
    throw new RangeError(
      `Mask box ${width}x${height} at (${x}, ${y}) lies outside its ` +
        `${imageWidth}x${imageHeight} image`,
    );
  }
}

/**
 * Rejects a decode whose *work* would exceed the cap, before that work starts.
 *
 * The area guard bounds what gets allocated; this bounds what gets scanned.
 * They are different numbers for a sparse format like COCO RLE, where the
 * payload names an image size but the decoder only walks the foreground.
 */
export function assertDecodableCount(pixels: number, maxPixels?: number): void {
  const cap = maxPixels ?? DEFAULT_MAX_MASK_PIXELS;
  if (pixels > cap) throw new MaskCapacityExceededError(pixels, cap);
}
