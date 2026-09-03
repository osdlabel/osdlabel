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

/**
 * Format identifier for osdlabel's internal mask representation.
 *
 * `@osdlabel/annotation` declares the same string as `MASK_RAW_FORMAT`. Both
 * packages are deliberately dependency-free, so neither can import the other;
 * `osdlabel` depends on both and asserts at compile time that they agree.
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
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Base64 of LEB128 run lengths, row-major, starting with background. */
  readonly counts: string;
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
  assertBoxInsideImage(
    snapshot.x,
    snapshot.y,
    snapshot.width,
    snapshot.height,
    snapshot.imageWidth,
    snapshot.imageHeight,
  );
  return {
    x: snapshot.x,
    y: snapshot.y,
    width: snapshot.width,
    height: snapshot.height,
    imageWidth: snapshot.imageWidth,
    imageHeight: snapshot.imageHeight,
    counts: area === 0 ? '' : bytesToBase64(encodeVarints(toRuns(snapshot.data))),
  };
}

/**
 * Decodes a canonical payload.
 *
 * Payloads routinely arrive from disk or the network, so the dimensions are
 * treated as untrusted: an absurd `width * height` is rejected before any
 * allocation rather than surfacing as an out-of-memory crash.
 */
export function decodeCanonical(
  data: CanonicalMaskData,
  options?: MaskDecodeOptions,
): MaskSnapshot {
  assertDecodableArea(data.width, data.height, options?.maxPixels);
  assertDecodableOrigin(data.x, data.y);
  // The image dimensions travel with the mask and are what COCO export uses to
  // place it. A fractional one is as meaningless here as on the COCO path,
  // which already rejects it — no cap, since nothing allocates from these.
  assertCountableImage(data.imageWidth, data.imageHeight);
  assertBoxInsideImage(data.x, data.y, data.width, data.height, data.imageWidth, data.imageHeight);
  const area = data.width * data.height;
  if (area === 0) return emptySnapshot(data.imageWidth, data.imageHeight);
  return {
    x: data.x,
    y: data.y,
    width: data.width,
    height: data.height,
    data: fromRuns(decodeVarints(base64ToBytes(data.counts)), area),
    imageWidth: data.imageWidth,
    imageHeight: data.imageHeight,
  };
}

/** The codec used for masks held in annotation state. */
export const canonicalMaskCodec: MaskCodec<CanonicalMaskData> = {
  format: CANONICAL_MASK_FORMAT,
  encode: encodeCanonical,
  decode: decodeCanonical,
};
