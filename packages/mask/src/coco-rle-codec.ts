import {
  assertBoxInsideImage,
  assertCountableImage,
  assertDecodableArea,
  assertDecodableCount,
} from './decode-guard.js';
import { emptySnapshot, snapshotPixelCount, type MaskSnapshot } from './mask-buffer.js';
import type { MaskCodec, MaskDecodeOptions } from './mask-codec.js';

export const COCO_RLE_FORMAT = 'coco-rle';
export const COCO_RLE_UNCOMPRESSED_FORMAT = 'coco-rle-uncompressed';

/** COCO's `segmentation` object with LEB128-style compressed counts. */
export interface CocoRleSegmentation {
  /** `[height, width]` of the **full image**, per the COCO spec. */
  readonly size: readonly [number, number];
  readonly counts: string;
}

/** COCO's `segmentation` object with plain integer run lengths. */
export interface CocoRleUncompressedSegmentation {
  readonly size: readonly [number, number];
  readonly counts: readonly number[];
}

/**
 * Converts a mask to COCO run lengths: **column-major** over the full image,
 * alternating and starting with background.
 *
 * Only the mask's bounding box is walked pixel by pixel — the fully-background
 * columns above, below, and to either side are added arithmetically. That keeps
 * export affordable on deep-zoom images, where iterating every pixel would mean
 * billions of steps.
 */
export function snapshotToCocoCounts(snapshot: MaskSnapshot): number[] {
  const { x, y, width, height, data, imageWidth, imageHeight } = snapshot;
  const total = imageWidth * imageHeight;
  if (width === 0 || height === 0) return total > 0 ? [total] : [];

  // COCO runs describe the whole image, so a box poking outside it cannot be
  // expressed: the background either side would have to be negative. Silently
  // clamping would shift every column, so refuse instead.
  assertBoxInsideImage(x, y, width, height, imageWidth, imageHeight);

  const runs: number[] = [];
  let currentValue: 0 | 1 = 0;
  let currentLength = 0;

  const append = (value: 0 | 1, length: number): void => {
    if (length <= 0) return;
    if (value === currentValue) {
      currentLength += length;
      return;
    }
    runs.push(currentLength);
    currentValue = value;
    currentLength = length;
  };

  append(0, x * imageHeight);
  const below = imageHeight - (y + height);
  for (let col = 0; col < width; col++) {
    append(0, y);
    for (let row = 0; row < height; row++) {
      append(data[row * width + col] === 1 ? 1 : 0, 1);
    }
    append(0, below);
  }
  append(0, (imageWidth - (x + width)) * imageHeight);

  runs.push(currentLength);
  return runs;
}

/** Rebuilds a tightly-cropped snapshot from COCO column-major run lengths. */
export function cocoCountsToSnapshot(
  counts: readonly number[],
  imageHeight: number,
  imageWidth: number,
  options?: MaskDecodeOptions,
): MaskSnapshot {
  // Counts describe the whole image, so they must sum to exactly its area.
  // Rejecting here keeps a malformed payload from driving an unbounded loop.
  // `imageHeight` divides indices into rows below; a fractional value makes
  // every derived row fractional, which silently drops pixels instead of
  // failing. Reject before any of that runs.
  assertCountableImage(imageWidth, imageHeight);

  let total = 0;
  for (const run of counts) {
    if (!Number.isFinite(run) || run < 0) {
      throw new RangeError(`COCO run lengths must be finite and non-negative, got ${run}`);
    }
    total += run;
  }
  const area = imageWidth * imageHeight;
  if (counts.length > 0 && total !== area) {
    throw new RangeError(`COCO counts sum to ${total}, but the image has ${area} pixels`);
  }

  // Bound the work before doing any. The scans below are O(foreground pixels),
  // and `area` comes from the payload's own `size` — so a hostile document
  // declaring a gigapixel image with one full-image run would otherwise spin
  // for hours before the allocation guard further down ever ran.
  //
  // The foreground count is what the scans actually walk, so that is what is
  // capped; a huge image holding a small mask stays decodable.
  let foreground = 0;
  for (let i = 1; i < counts.length; i += 2) foreground += counts[i]!;
  assertDecodableCount(foreground, options?.maxPixels);

  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;

  // The bounding box comes from run *boundaries*, not from visiting each
  // foreground pixel: a run occupies a contiguous span of the column-major
  // index, so its extent follows from its endpoints. That makes this pass
  // O(runs) instead of O(foreground pixels) — for a full-image mask, two
  // divisions instead of a billion iterations — so the capacity check below
  // is reached immediately rather than after the scan it is meant to prevent.
  {
    let index = 0;
    let value: 0 | 1 = 0;
    for (const run of counts) {
      if (value === 1 && run > 0) {
        const firstCol = Math.floor(index / imageHeight);
        const lastCol = Math.floor((index + run - 1) / imageHeight);
        if (firstCol < minCol) minCol = firstCol;
        if (lastCol > maxCol) maxCol = lastCol;
        if (firstCol === lastCol) {
          // Wholly inside one column: rows are just the run's own extent.
          const firstRow = index % imageHeight;
          const lastRow = (index + run - 1) % imageHeight;
          if (firstRow < minRow) minRow = firstRow;
          if (lastRow > maxRow) maxRow = lastRow;
        } else {
          // It spans a column boundary, so it reaches the bottom of one column
          // and the top of the next — which is every row, whether it crosses
          // one boundary or many.
          minRow = 0;
          maxRow = imageHeight - 1;
        }
      }
      index += run;
      value = value === 1 ? 0 : 1;
    }
  }

  if (maxCol < 0 || !Number.isFinite(minCol)) return emptySnapshot(imageWidth, imageHeight);

  const width = maxCol - minCol + 1;
  const height = maxRow - minRow + 1;
  // Only the bounding box is materialised, so that — not the image area — is
  // what has to fit. A tiny mask on a gigapixel canvas is perfectly decodable.
  assertDecodableArea(width, height, options?.maxPixels);
  const data = new Uint8Array(width * height);
  {
    let index = 0;
    let value: 0 | 1 = 0;
    for (const run of counts) {
      if (value === 1) {
        // Counted, not compared: `i < index + run` relies on `i++` advancing,
        // which stops being true once the index passes the exact-integer range.
        // `assertCountableImage` rules that out, and counting makes the loop
        // structurally finite regardless.
        let i = index;
        for (let remaining = run; remaining > 0; remaining--, i++) {
          data[((i % imageHeight) - minRow) * width + (Math.floor(i / imageHeight) - minCol)] = 1;
        }
      }
      index += run;
      value = value === 1 ? 0 : 1;
    }
  }

  return { x: minCol, y: minRow, width, height, data, imageWidth, imageHeight };
}

/**
 * pycocotools' `rleToString`: each count (delta-coded against two positions
 * back, after the first two) is emitted in 5-bit chunks, bit `0x20` marking
 * continuation and bit `0x10` carrying sign, offset by 48 into printable ASCII.
 *
 * Arithmetic is done with division rather than bit operators because a
 * background run on a gigapixel image easily exceeds the 32 bits that
 * JavaScript's bitwise operators coerce to.
 */
export function encodeCocoCountsString(counts: readonly number[]): string {
  let out = '';
  for (let i = 0; i < counts.length; i++) {
    let value = counts[i]!;
    if (i > 2) value -= counts[i - 2]!;
    let more = true;
    while (more) {
      let chunk = ((value % 32) + 32) % 32;
      value = Math.floor(value / 32);
      more = (chunk & 0x10) !== 0 ? value !== -1 : value !== 0;
      if (more) chunk |= 0x20;
      out += String.fromCharCode(chunk + 48);
    }
  }
  return out;
}

/**
 * Inverse of {@link encodeCocoCountsString}.
 *
 * COCO counts strings travel through JSON files written by other tools, so the
 * input is treated as untrusted: a character outside the 6-bit alphabet, a
 * value too large to represent exactly, a stream that ends mid-value, or a
 * delta that resolves to a negative run all mean the payload is not a valid
 * encoding. Each is rejected rather than decoded into a mask that looks
 * plausible but is wrong.
 */
export function decodeCocoCountsString(encoded: string): number[] {
  const counts: number[] = [];
  let position = 0;
  while (position < encoded.length) {
    let value = 0;
    let shift = 0;
    let more = true;
    while (more) {
      if (position >= encoded.length) {
        throw new RangeError('COCO counts string ended mid-value');
      }
      const chunk = encoded.charCodeAt(position) - 48;
      position++;
      if (chunk < 0 || chunk > 0x3f) {
        throw new RangeError(
          `COCO counts string holds a character outside its alphabet at index ${position - 1}`,
        );
      }
      if (shift > MAX_COCO_CHUNKS) {
        throw new RangeError('COCO run length exceeds the safe integer range');
      }
      value += (chunk & 0x1f) * Math.pow(2, 5 * shift);
      more = (chunk & 0x20) !== 0;
      shift++;
      // Sign-extend the final chunk when its sign bit is set.
      if (!more && (chunk & 0x10) !== 0) value -= Math.pow(2, 5 * shift);
    }
    if (counts.length > 2) value += counts[counts.length - 2]!;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`COCO counts string decodes to an invalid run length: ${value}`);
    }
    counts.push(value);
  }
  return counts;
}

/** Beyond this a 5-bit chunked count can no longer be represented exactly. */
const MAX_COCO_CHUNKS = 10;

/**
 * Largest image area whose COCO run lengths are guaranteed to survive a
 * round-trip through `pycocotools`.
 *
 * The reference implementation stores run lengths in a 32-bit unsigned array.
 * A run longer than this is silently truncated on read, which keeps the mask's
 * area correct but relocates it — a 100000x100000 image with a mask at its
 * centre comes back near the top-left corner. Since no run can exceed the total
 * pixel count, an image within this bound is always safe.
 *
 * Our own encoder and decoder handle larger runs correctly; this bound describes
 * what one downstream reader can accept, and nothing in this package enforces
 * it — see {@link isCocoInteropSafe}, which callers opt into.
 */
export const COCO_MAX_INTEROP_IMAGE_PIXELS = 0xffffffff;

/**
 * Whether this mask's COCO encoding can be read back correctly by
 * `pycocotools` — see {@link COCO_MAX_INTEROP_IMAGE_PIXELS}.
 *
 * Worth checking before exporting masks from very large (deep-zoom) images,
 * because the failure is silent.
 */
export function isCocoInteropSafe(snapshot: MaskSnapshot): boolean {
  return snapshot.imageWidth * snapshot.imageHeight <= COCO_MAX_INTEROP_IMAGE_PIXELS;
}

/** COCO `bbox`: `[x, y, width, height]` of the mask's bounding box. */
export function cocoBbox(snapshot: MaskSnapshot): [number, number, number, number] {
  return [snapshot.x, snapshot.y, snapshot.width, snapshot.height];
}

/** COCO `area`: the exact count of foreground pixels. */
export function cocoArea(snapshot: MaskSnapshot): number {
  return snapshotPixelCount(snapshot);
}

/**
 * Canonical COCO RLE — what `pycocotools` emits and consumes.
 *
 * Verified against the reference implementation: for the fixtures in
 * `tests/fixtures/pycocotools-golden.json`, `pycocotools.mask.encode` produces
 * byte-identical counts to this codec, and its `decode` returns pixel-identical
 * masks.
 *
 * **A limitation in `pycocotools`, not here.** It stores run lengths in a
 * 32-bit unsigned array, so a run longer than
 * {@link COCO_MAX_INTEROP_IMAGE_PIXELS} is silently truncated when it reads a
 * mask back: the area survives but the mask *moves*. A mask at the centre of a
 * 100000x100000 image reappears near the top-left corner.
 *
 * This codec encodes and decodes such runs correctly and deliberately does
 * **not** refuse, clamp, or warn about them — the output is valid COCO, and
 * imposing a limit here would be wrong for consumers whose tooling reads wide
 * counts. Callers who care can check {@link isCocoInteropSafe} themselves; it
 * is offered as a utility and never applied automatically.
 */
export const cocoRleCodec: MaskCodec<CocoRleSegmentation> = {
  format: COCO_RLE_FORMAT,
  encode(snapshot) {
    return {
      size: [snapshot.imageHeight, snapshot.imageWidth],
      counts: encodeCocoCountsString(snapshotToCocoCounts(snapshot)),
    };
  },
  decode(payload, options) {
    const [height, width] = payload.size;
    return cocoCountsToSnapshot(decodeCocoCountsString(payload.counts), height, width, options);
  },
};

/** COCO RLE with plain integer counts — easier to inspect, same ordering. */
export const cocoRleUncompressedCodec: MaskCodec<CocoRleUncompressedSegmentation> = {
  format: COCO_RLE_UNCOMPRESSED_FORMAT,
  encode(snapshot) {
    return {
      size: [snapshot.imageHeight, snapshot.imageWidth],
      counts: snapshotToCocoCounts(snapshot),
    };
  },
  decode(payload, options) {
    const [height, width] = payload.size;
    return cocoCountsToSnapshot(payload.counts, height, width, options);
  },
};
