import {
  throwIfAborted,
  type EncodeView,
  type EncodedView,
  type SegmentationEncoder,
} from '@osdlabel/segmentation';
import { decodeWire, type WireBlob, type WireDType } from './wire.js';

export interface RemoteEncoderOptions<TEmbedding> {
  /** POST endpoint; receives `{ view, dtype }` JSON, returns the wire format. */
  readonly url: string;
  /** The decoder's model input side, as {@link SegmentationEncoder.inputSize}. */
  readonly inputSize: number;
  /** Embedding precision on the wire. Default `float16` (optional: servers may send float32). */
  readonly dtype?: Extract<WireDType, 'float16' | 'float32'> | undefined;
  readonly fetch?: typeof fetch | undefined;
  /**
   * Builds the local decoder's embedding from the received tensors, e.g.
   * `@osdlabel/segmentation-onnx`'s `samEmbeddingFromTensors`. This package
   * never knows the model family: the app composes the two.
   */
  readonly toEmbedding: (blobs: readonly WireBlob[], view: EncodeView) => TEmbedding;
  /** Bytes the embedding occupies in the cache. */
  readonly bytesOf: (embedding: TEmbedding) => number;
}

/** Server-reported timings travel in the wire header's meta. */
interface EncodeMeta {
  readonly timings?: Record<string, number>;
}

/**
 * Server encode -> browser decode. The server reads the view from its own copy
 * of the image (it never needs the browser's pixels), runs the encoder, and
 * returns the embedding; the browser's decoder then answers every click
 * locally. Same contract as an in-browser encoder, so the tool cannot tell.
 */
export function createRemoteEncoder<TEmbedding>(
  options: RemoteEncoderOptions<TEmbedding>,
): SegmentationEncoder<TEmbedding> {
  const doFetch = options.fetch ?? fetch;
  return {
    inputSize: options.inputSize,
    async encode(view: EncodeView, signal): Promise<EncodedView<TEmbedding>> {
      const t0 = performance.now();
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ view, dtype: options.dtype ?? 'float16' }),
        signal,
      });
      if (!res.ok) throw new Error(`remote encode failed: HTTP ${res.status} ${await res.text()}`);
      const buffer = await res.arrayBuffer();
      const t1 = performance.now();
      throwIfAborted(signal);
      const { blobs, meta } = decodeWire<EncodeMeta>(buffer);
      const t2 = performance.now();
      const embedding = options.toEmbedding(blobs, view);
      return {
        view,
        embedding,
        bytes: options.bytesOf(embedding),
        timings: {
          ...meta.timings,
          roundTrip: t1 - t0,
          wireBytes: buffer.byteLength,
          wireDecode: t2 - t1,
        },
      };
    },
  };
}
