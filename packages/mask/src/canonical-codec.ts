import { base64ToBytes, bytesToBase64, decodeVarints, encodeVarints } from './binary.js';
import {
  assertBoxInsideImage,
  assertCountableImage,
  assertDecodableArea,
  assertDecodableOrigin,
  assertPixelDimensions,
} from './decode-guard.js';
import { emptySnapshot, type MaskSnapshot } from './mask-buffer.js';
import type { MaskCodec, MaskDecodeOptions } from './mask-codec.js';
import { assertMaskDownsample, maskGridSize, snapshotImageBox } from './downsample.js';

/**
 * Format identifier for osdlabel's internal mask representation.
 *
 * `@osdlabel/annotation` declares the same string as `MASK_RAW_FORMAT`. Both
 * packages are deliberately dependency-free, so neither can import the other;
 * `osdlabel` depends on both and asserts at compile time that they agree.
 *
 * The string is the version: an incompatible change to `CanonicalMaskData`
 * is a new format string, never a change under this one (see the note on
 * `MASK_RAW_FORMAT`).
 */
export const CANONICAL_MASK_FORMAT = 'osdlabel-mask' as const;

/**
 * osdlabel's own mask payload: the bounding box, the image it belongs to, and
 * row-major run lengths (alternating, starting with a run of background)
 * encoded as unsigned LEB128 varints and base64'd.
 *
 * Deliberately *not* COCO. Keeping the annotator's state in a simple, neutral
 * format means the choice of downstream format stays a pure export concern —
 * and avoids COCO's column-major ordering and signed-delta string encoding
 * leaking into painting, undo, or rendering.
 */
export interface CanonicalMaskData {
  /**
   * The box in image (level-0) pixels at every downsample, so a reader that
   * only wants to know where a mask is never needs the factor. At a
   * downsample `d` above 1 the box is cell-aligned: `x` and `y` are multiples
   * of `d`, and so are its right and bottom edges unless they are the image's.
   */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /**
   * Base64 of LEB128 run lengths, row-major, starting with background, over
   * the box's `ceil(width / d) x ceil(height / d)` cells.
   */
  readonly counts: string;
  /**
   * Image pixels per cell along each axis, a power of two; absent means 1 and
   * is how 1 is written, so a full-resolution payload is byte-for-byte what it
   * was before the field existed.
   *
   * A reader that predates the field and drops it does not misplace the mask:
   * it reads the box as a level-0 grid of `width x height` cells, the runs sum
   * to the coarser grid instead, and `fromRuns` refuses the payload.
   */
  readonly downsample?: number;
}

/** Extracts alternating run lengths (starting with background) from row-major pixels. */
export function toRuns(data: Uint8Array): number[] {
  const runs: number[] = [];
  let currentValue = 0;
  let currentLength = 0;
  for (let i = 0; i < data.length; i++) {
    const value = data[i] === 1 ? 1 : 0;
    if (value === currentValue) {
      currentLength++;
    } else {
      runs.push(currentLength);
      currentValue = value;
      currentLength = 1;
    }
  }
  runs.push(currentLength);
  return runs;
}

/**
 * Expands alternating run lengths (starting with background) into row-major
 * pixels.
 *
 * The runs must describe exactly `length` pixels. A short or long stream means
 * the payload disagrees with the box it claims to fill, and quietly padding or
 * truncating would turn a corrupt payload into a plausible-looking mask.
 */
export function fromRuns(runs: readonly number[], length: number): Uint8Array {
  let total = 0;
  for (const run of runs) {
    if (!Number.isInteger(run) || run < 0) {
      throw new RangeError(`Run lengths must be non-negative integers, got ${run}`);
    }
    total += run;
  }
  if (total !== length) {
    throw new RangeError(`Run lengths sum to ${total}, but the box holds ${length} pixels`);
  }

  const data = new Uint8Array(length);
  let index = 0;
  let value = 0;
  for (const run of runs) {
    if (value === 1) data.fill(1, index, index + run);
    index += run;
    value = value === 1 ? 0 : 1;
  }
  return data;
}

/**
 * Encodes a snapshot to the canonical payload.
 *
 * Every invariant {@link decodeCanonical} enforces is enforced here too, so a
 * payload this function produces is one it can read back. Only the buffers in
 * this package clip their writes to the image; a host that hands us a snapshot
 * it assembled itself can place the box anywhere, and without this the mistake
 * surfaces one save-and-reload later as an annotation that vanishes — or worse,
 * one silently truncated by the next stroke that touches it.
 */
export function encodeCanonical(snapshot: MaskSnapshot): CanonicalMaskData {
  const downsample = snapshot.downsample ?? 1;
  assertMaskDownsample(downsample);
  const area = snapshot.width * snapshot.height;
  if (snapshot.data.length !== area) {
    throw new RangeError(
      `Snapshot data has ${snapshot.data.length} pixels but its box describes ${area}`,
    );
  }
  // Not covered by the length check above: a fractional box can still multiply
  // out to a whole number (0.5 x 4), and two negative sides multiply out to a
  // positive area. `assertDecodableArea` refuses both on the way back in.
  assertPixelDimensions(snapshot.width, snapshot.height);
  assertDecodableOrigin(snapshot.x, snapshot.y);
  assertCountableImage(snapshot.imageWidth, snapshot.imageHeight);
  // A 5x0 box is the empty mask, and decodes as one: write it that way, so the
  // payload does not carry a placement that can fail the box check on the way
  // back in (a zero-width box at `x = imageWidth` is inside the image by the
  // arithmetic and outside it by the check).
  if (area === 0) {
    const empty = emptySnapshot(snapshot.imageWidth, snapshot.imageHeight);
    return {
      x: empty.x,
      y: empty.y,
      width: empty.width,
      height: empty.height,
      imageWidth: snapshot.imageWidth,
      imageHeight: snapshot.imageHeight,
      counts: '',
    };
  }
  // In cells, against the image's cell grid: that is the space the box and
  // its data are in.
  const grid = maskGridSize(snapshot.imageWidth, snapshot.imageHeight, downsample);
  assertBoxInsideImage(
    snapshot.x,
    snapshot.y,
    snapshot.width,
    snapshot.height,
    grid.width,
    grid.height,
  );
  const box = snapshotImageBox(snapshot);
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    imageWidth: snapshot.imageWidth,
    imageHeight: snapshot.imageHeight,
    counts: bytesToBase64(encodeVarints(toRuns(snapshot.data))),
    ...(downsample !== 1 ? { downsample } : {}),
  };
}

/**
 * Rejects a downsampled box that does not sit on its cell grid.
 *
 * The encoder only writes aligned boxes, so an unaligned one is corrupt — and
 * reading it anyway would shift every cell by the misalignment, or round the
 * box to a grid it was not painted on. Edges that are the image's own are
 * exempt: the last cell of a row or column is clipped there.
 */
function assertCellAligned(data: CanonicalMaskData, downsample: number): void {
  const right = data.x + data.width;
  const bottom = data.y + data.height;
  if (
    data.x % downsample !== 0 ||
    data.y % downsample !== 0 ||
    (right % downsample !== 0 && right !== data.imageWidth) ||
    (bottom % downsample !== 0 && bottom !== data.imageHeight)
  ) {
    throw new RangeError(
      `Mask box ${data.width}x${data.height} at (${data.x}, ${data.y}) is not aligned ` +
        `to its ${downsample}-pixel cells`,
    );
  }
}

/**
 * Rejects a `counts` string longer than any encoding of `area` pixels can be.
 *
 * The area cap bounds the pixels a decode allocates, but the runs are decoded
 * in full before they are compared with the box, so without this a payload
 * for a one-pixel mask can carry tens of megabytes of varints and buy seconds
 * of work and hundreds of megabytes of heap under a cap of 1. A valid payload
 * holds at most `area + 1` non-empty runs plus a trailing empty one that the
 * decoder tolerates, each at most 8 LEB128 bytes (the run is bounded by the
 * area, which is bounded by `Number.MAX_SAFE_INTEGER`), and base64 expands
 * three bytes into four characters.
 */
function assertCountsFitBox(counts: unknown, area: number): void {
  if (typeof counts !== 'string') {
    throw new RangeError(`Run lengths must be a base64 string, got ${typeof counts}`);
  }
  const longest = 4 * Math.ceil((8 * (area + 2)) / 3);
  if (counts.length > longest) {
    throw new RangeError(
      `Run lengths are ${counts.length} characters, longer than any encoding of ${area} pixels`,
    );
  }
}

/**
 * Decodes a canonical payload.
 *
 * Payloads routinely arrive from disk or the network, so the dimensions are
 * treated as untrusted: an absurd `width * height` is rejected before any
 * allocation rather than surfacing as an out-of-memory crash, and the run
 * lengths are bounded by the box before they are decoded.
 */
export function decodeCanonical(
  data: CanonicalMaskData,
  options?: MaskDecodeOptions,
): MaskSnapshot {
  const downsample = data.downsample ?? 1;
  assertMaskDownsample(downsample);
  assertPixelDimensions(data.width, data.height);
  // The cap bounds what is allocated, which is the cell grid, not the box.
  const cellsWide = Math.ceil(data.width / downsample);
  const cellsHigh = Math.ceil(data.height / downsample);
  assertDecodableArea(cellsWide, cellsHigh, options?.maxPixels);
  assertDecodableOrigin(data.x, data.y);
  // The image dimensions travel with the mask and are what COCO export uses to
  // place it. A fractional one is as meaningless here as on the COCO path,
  // which already rejects it — no cap, since nothing allocates from these.
  assertCountableImage(data.imageWidth, data.imageHeight);
  assertBoxInsideImage(data.x, data.y, data.width, data.height, data.imageWidth, data.imageHeight);
  const area = cellsWide * cellsHigh;
  if (area === 0) return emptySnapshot(data.imageWidth, data.imageHeight);
  if (downsample !== 1) assertCellAligned(data, downsample);
  assertCountsFitBox(data.counts, area);
  return {
    x: data.x / downsample,
    y: data.y / downsample,
    width: cellsWide,
    height: cellsHigh,
    data: fromRuns(decodeVarints(base64ToBytes(data.counts)), area),
    imageWidth: data.imageWidth,
    imageHeight: data.imageHeight,
    ...(downsample !== 1 ? { downsample } : {}),
  };
}

/** The codec used for masks held in annotation state. */
export const canonicalMaskCodec: MaskCodec<CanonicalMaskData> = {
  format: CANONICAL_MASK_FORMAT,
  encodesDownsampled: true,
  encode: encodeCanonical,
  decode: decodeCanonical,
};
