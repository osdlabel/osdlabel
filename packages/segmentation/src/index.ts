export type {
  SegmentationProvider,
  SegmentationImageRef,
  SegmentationPrompt,
  SegmentationResult,
  SegmentationPoint,
  SegmentationPointLabel,
  SegmentationBox,
} from './segmentation-provider.js';

// Decomposed encode/decode strategies + composition.
export type { SegmentationEncoder } from './encoder.js';
export type { SegmentationDecoder } from './decoder.js';
export { composeSegmentationProvider } from './compose.js';

// Pure, model-agnostic helpers.
export type { SegmentationMask } from './mask.js';
export { maskToContours } from './mask-to-contours.js';
export type { MaskToContoursOptions } from './mask-to-contours.js';
export { computeResizeTransform, imageToModel, modelToImage } from './resize-transform.js';
export type { ResizeTransform, ComputeResizeTransformOptions } from './resize-transform.js';
