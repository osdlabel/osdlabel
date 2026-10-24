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
export {
  DEFAULT_ENCODE_POLICY,
  planEncodeView,
  canReuse,
  promptBounds,
  promptExtent,
} from './encode-plan.js';
export type { EmbeddingCacheOptions, CacheLookup, CacheEntry } from './embedding-cache.js';
export { EmbeddingCache } from './embedding-cache.js';
export type { ComposeOptions } from './compose.js';
export { composeSegmentationProvider } from './compose.js';
export type { InputLayout, ModelFrame } from './model-frame.js';
export {
  modelFrame,
  imageToModel,
  modelToImage,
  modelGridFrame,
  cropGrid,
  sameRasterFrame,
  resampleLogits,
} from './model-frame.js';
export type {
  CandidateRanking,
  RasterToSnapshotOptions,
  RasterToPolygonsOptions,
} from './raster.js';
export {
  stabilityScore,
  rankCandidates,
  rasterImageBounds,
  rasterToMaskSnapshot,
  rasterToPolygons,
  tighten,
} from './raster.js';
// DRAFT: the stateful session contract stacks, volumes and video need (research).
export type {
  FrameIndex,
  SegmentationObjectId,
  SessionCapabilities,
  FramePrompt,
  FrameResult,
  PropagateRequest,
  SegmentationSession,
  SeriesTarget,
  SegmentationSessionBackend,
} from './session.js';
