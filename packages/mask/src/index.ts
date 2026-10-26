// Runtime pixel storage.
export type { MaskBuffer, MaskCellBox, MaskSnapshot, MaskRegion } from './mask-buffer.js';

// The read-only raster contract every reader speaks; storage-agnostic.
export type {
  MaskLevel0SpanVisitor,
  MaskRaster,
  MaskRasterInput,
  MaskSpanVisitor,
} from './mask-raster.js';
export {
  asMaskRaster,
  denseRaster,
  forEachCheckedSpan,
  forEachLevel0Span,
  isMaskRaster,
  rasterPixelCount,
  rasterToRuns,
  runRaster,
  toDenseSnapshot,
} from './mask-raster.js';
export type { MaskBoxFields } from './downsample.js';
export {
  MaskCapacityExceededError,
  emptySnapshot,
  snapshotCellCount,
  snapshotPixelCount,
} from './mask-buffer.js';

// Resolution: masks stored on a coarser cell grid than the image.
export {
  MAX_MASK_DOWNSAMPLE,
  assertMaskDownsample,
  isMaskDownsample,
  maskDownsampleOf,
  maskGridSize,
  snapshotImageBox,
  upsampleSnapshot,
} from './downsample.js';
export { BoundedDenseMaskBuffer, DEFAULT_MAX_MASK_PIXELS } from './bounded-dense-mask-buffer.js';
export {
  assertBoxInsideImage,
  assertCountableImage,
  assertDecodableArea,
  assertDecodableCount,
  assertDecodableOrigin,
  MAX_IMAGE_SIDE,
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
  decodeCanonicalRaster,
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
  CocoRunLimitExceededError,
  MAX_COCO_RUNS,
  countCocoRuns,
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
