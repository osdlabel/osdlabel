import type {
  SegmentationImageRef,
  SegmentationPrompt,
  SegmentationResult,
} from './segmentation-provider.js';

/**
 * The decoder half of a decomposed {@link SegmentationProvider}: the (typically
 * cheap, per-prompt) step that turns an embedding + prompt into contours.
 *
 * `TEmbedding` must match the paired
 * {@link import('./encoder.js').SegmentationEncoder}'s output; see that file for
 * how the type parameter encodes the decode topology.
 */
export interface SegmentationDecoder<TEmbedding> {
  /**
   * Run inference for `prompt` against a previously computed `embedding`. The
   * `image` ref is passed through for decoders that need original dimensions or
   * pixels. The `signal` aborts when a newer prompt supersedes this one.
   */
  decode(
    embedding: TEmbedding,
    image: SegmentationImageRef,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult>;
  /** Optionally release decoder-wide resources (e.g. an ORT session). */
  dispose?(): void;
}
