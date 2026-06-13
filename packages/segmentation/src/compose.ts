import type { ImageId } from '@osdlabel/viewer-api';
import type { SegmentationEncoder } from './encoder.js';
import type { SegmentationDecoder } from './decoder.js';
import type { SegmentationProvider, SegmentationImageRef } from './segmentation-provider.js';

interface CacheEntry<TEmbedding> {
  readonly promise: Promise<TEmbedding>;
  readonly controller: AbortController;
}

/**
 * Builds a {@link SegmentationProvider} from a separately-supplied
 * {@link SegmentationEncoder} and {@link SegmentationDecoder}, owning the
 * per-image embedding cache and in-flight de-duplication so the two strategies
 * stay decoupled. This is what makes the decode topologies (server-encode →
 * client-decode, all-server, all-client) a single type-checked composition.
 *
 * Lifecycle notes:
 * - The **encode is owned by the cache**, not by the caller's prompt: it runs
 *   under an internal `AbortController` and is aborted only by `dispose(imageId)`.
 *   This is deliberate — a superseded *prompt* must not cancel the (expensive,
 *   reusable) image encode. Per-prompt cancellation flows to `decode` via the
 *   `segment` signal.
 * - A `segment` that arrives before/without `prepare` still works: it awaits the
 *   in-flight (or starts the) encode.
 * - A failed encode is **evicted** so the next call retries rather than caching
 *   a rejected promise.
 *
 * The cache is unbounded in v1 (bounded by the number of distinct images);
 * callers free entries via `dispose(imageId)`. An LRU bound can be added later.
 */
export function composeSegmentationProvider<TEmbedding>(
  encoder: SegmentationEncoder<TEmbedding>,
  decoder: SegmentationDecoder<TEmbedding>,
): SegmentationProvider {
  const cache = new Map<ImageId, CacheEntry<TEmbedding>>();

  function getEmbedding(image: SegmentationImageRef): Promise<TEmbedding> {
    const existing = cache.get(image.imageId);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = encoder.encode(image, controller.signal);
    cache.set(image.imageId, { promise, controller });
    // Evict on failure so a later prompt retries instead of awaiting a rejection.
    promise.catch(() => {
      if (cache.get(image.imageId)?.promise === promise) cache.delete(image.imageId);
    });
    return promise;
  }

  return {
    async prepare(image, signal) {
      if (signal.aborted) return;
      await getEmbedding(image);
    },
    async segment(image, prompt, signal) {
      const embedding = await getEmbedding(image);
      return decoder.decode(embedding, image, prompt, signal);
    },
    dispose(imageId) {
      const entry = cache.get(imageId);
      if (entry) {
        entry.controller.abort();
        cache.delete(imageId);
      }
      encoder.dispose?.(imageId);
    },
  };
}
