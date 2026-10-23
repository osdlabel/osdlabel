import { EmbeddingCache, type EmbeddingCacheOptions } from './embedding-cache.js';
import { DEFAULT_ENCODE_POLICY, planEncodeView, type EncodePolicy } from './encode-plan.js';
import {
  throwIfAborted,
  type SegmentationDecoder,
  type SegmentationEncoder,
  type SegmentationProvider,
} from './provider.js';

export interface ComposeOptions {
  readonly policy?: Partial<EncodePolicy> | undefined;
  readonly cache?: EmbeddingCacheOptions | undefined;
}

/**
 * Joins an encoder and a decoder into a {@link SegmentationProvider} that owns
 * the viewport-crop policy and the embedding cache.
 *
 * The shared `TEmbedding` type parameter pairs compatible halves at compile
 * time, which is what makes the topologies interchangeable: an ONNX encoder in
 * a worker, or an HTTP encoder whose embedding a browser decoder consumes.
 */
export function composeSegmentationProvider<TEmbedding>(
  encoder: SegmentationEncoder<TEmbedding>,
  decoder: SegmentationDecoder<TEmbedding>,
  options?: ComposeOptions,
): SegmentationProvider & { readonly cache: EmbeddingCache<TEmbedding> } {
  const policy: EncodePolicy = {
    ...DEFAULT_ENCODE_POLICY,
    inputSize: encoder.inputSize,
    ...options?.policy,
  };
  const cache = new EmbeddingCache<TEmbedding>(options?.cache);
  const encode = encoder.encode.bind(encoder);

  return {
    cache,
    capabilities: { ...decoder.capabilities, inputSize: encoder.inputSize },
    async prepare(target, signal) {
      throwIfAborted(signal);
      const lookup = cache.lookupOrEncode(target, null, planEncodeView(target, policy), encode, policy);
      await lookup.entry;
    },
    async segment(target, prompt, signal) {
      const t0 = performance.now();
      const lookup = cache.lookupOrEncode(
        target,
        prompt,
        planEncodeView(target, policy),
        encode,
        policy,
      );
      const encoded = await lookup.entry;
      throwIfAborted(signal);
      const t1 = performance.now();
      const decoded = await decoder.decode(encoded, prompt, signal);
      const t2 = performance.now();
      return {
        candidates: decoded.candidates,
        view: encoded.view,
        cached: lookup.hit,
        timings: {
          ...(lookup.hit ? {} : encoded.timings),
          ...decoded.timings,
          waitEmbedding: t1 - t0,
          decodeTotal: t2 - t1,
        },
      };
    },
    dispose(imageKey) {
      cache.clear(imageKey);
      if (imageKey === undefined) {
        encoder.dispose?.();
        decoder.dispose?.();
      }
    },
  };
}
