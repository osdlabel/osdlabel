export type {
  SegmentationImageKey,
  ImageRegion,
  ImageSize,
  PromptPointLabel,
  PromptPoint,
  PromptBox,
  SegmentationPrompt,
  EncodeView,
  RasterFrame,
  RasterMask,
  MaskCandidate,
  SegmentationResult,
} from './types.js';
export type {
  ProviderCapabilities,
  SegmentationTarget,
  SegmentationProvider,
  EncodedView,
  SegmentationEncoder,
  SegmentationDecoder,
} from './provider.js';
export { abortError, throwIfAborted } from './provider.js';
export type { EncodePolicy, ReuseVerdict } from './encode-plan.js';
export { DEFAULT_ENCODE_POLICY, planEncodeView, canReuse, promptBounds } from './encode-plan.js';
export type { EmbeddingCacheOptions, CacheLookup, CacheEntry } from './embedding-cache.js';
export { EmbeddingCache } from './embedding-cache.js';
export type { ComposeOptions } from './compose.js';
export { composeSegmentationProvider } from './compose.js';
export type { InputLayout, ModelFrame } from './model-frame.js';
export { modelFrame, imageToModel, modelToImage, modelGridFrame, cropGrid } from './model-frame.js';
export type { CandidateRanking, RasterToSnapshotOptions, RasterToPolygonsOptions } from './raster.js';
export {
  stabilityScore,
  rankCandidates,
  rasterImageBounds,
  rasterToMaskSnapshot,
  rasterToPolygons,
  tighten,
} from './raster.js';
