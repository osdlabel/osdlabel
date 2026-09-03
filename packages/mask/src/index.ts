// Runtime pixel storage.
export type { MaskBuffer, MaskSnapshot, MaskRegion } from './mask-buffer.js';
export { MaskCapacityExceededError, emptySnapshot, snapshotPixelCount } from './mask-buffer.js';
export { BoundedDenseMaskBuffer, DEFAULT_MAX_MASK_PIXELS } from './bounded-dense-mask-buffer.js';
export {
  assertBoxInsideImage,
  assertCountableImage,
  assertDecodableArea,
  assertDecodableCount,
  assertDecodableOrigin,
} from './decode-guard.js';
export type { BoundedDenseMaskBufferOptions } from './bounded-dense-mask-buffer.js';

// Brush rasterization.
export { stampCircle, strokeSegment } from './stroke.js';

// Codec contract + registry (the extension point).
export type { MaskCodec, MaskCodecRegistry, MaskDecodeOptions } from './mask-codec.js';
export { createMaskCodecRegistry } from './mask-codec.js';

// Canonical (in-annotator) representation.
export {
  CANONICAL_MASK_FORMAT,
  canonicalMaskCodec,
  encodeCanonical,
  decodeCanonical,
  toRuns,
  fromRuns,
} from './canonical-codec.js';
export type { CanonicalMaskData } from './canonical-codec.js';

// Built-in downstream format: COCO RLE.
export {
  COCO_RLE_FORMAT,
  COCO_RLE_UNCOMPRESSED_FORMAT,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  snapshotToCocoCounts,
  cocoCountsToSnapshot,
  encodeCocoCountsString,
  decodeCocoCountsString,
  cocoBbox,
  cocoArea,
  isCocoInteropSafe,
  COCO_MAX_INTEROP_IMAGE_PIXELS,
} from './coco-rle-codec.js';
export type { CocoRleSegmentation, CocoRleUncompressedSegmentation } from './coco-rle-codec.js';
