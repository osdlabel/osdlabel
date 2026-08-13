import type { ImageId } from '@osdlabel/viewer-api';
import type { SegmentationImageRef } from './segmentation-provider.js';

/**
 * The encoder half of a decomposed {@link SegmentationProvider}: the (typically
 * expensive) step that turns an image into a reusable embedding handle.
 *
 * `TEmbedding` is intentionally opaque — it is whatever the paired
 * {@link import('./decoder.js').SegmentationDecoder} consumes, and is what
 * distinguishes the decode topologies:
 * - **server encode → client decode:** `TEmbedding` is the embedding tensor the
 *   server returns (bytes + shape), consumed by an in-browser decoder;
 * - **all-server (thin client):** `TEmbedding` is an opaque `{ sessionId }` handle;
 * - **all-client:** `TEmbedding` is an in-memory tensor.
 *
 * The shared type parameter forces a compatible encoder/decoder pair at compile
 * time when composed via {@link import('./compose.js').composeSegmentationProvider}.
 */
export interface SegmentationEncoder<TEmbedding> {
  /**
   * Compute the embedding for `image`. The `signal` aborts when the image is no
   * longer active; implementations should reject promptly on abort.
   */
  encode(image: SegmentationImageRef, signal: AbortSignal): Promise<TEmbedding>;
  /** Optionally release any per-image resources held for `imageId`. */
  dispose?(imageId: ImageId): void;
}
