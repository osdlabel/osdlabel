import {
  modelFrame,
  throwIfAborted,
  type EncodeView,
  type EncodedView,
  type MaskCandidate,
  type ProviderCapabilities,
  type RasterFrame,
  type SegmentationEncoder,
  type SegmentationProvider,
} from '@osdlabel/segmentation';
import { adapterFor, embeddingBytes, type ModelFamily, type SamEmbedding } from './families.js';
import { decodeWire, type WireDType } from './wire.js';

export interface RemoteEncoderOptions {
  /** POST endpoint; receives `{ view, dtype }` JSON, returns the wire format. */
  readonly url: string;
  readonly family: ModelFamily;
  readonly inputSize: number;
  /** Embedding precision on the wire. Default `float16`. */
  readonly dtype?: Extract<WireDType, 'float16' | 'float32'> | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/** Server-reported timings travel in the wire header's meta. */
interface EncodeMeta {
  readonly timings?: Record<string, number>;
}

/**
 * Server encode -> browser decode. The server reads the view from its own copy
 * of the image (it never needs the browser's pixels), runs the encoder, and
 * returns the embedding; the browser's decoder then answers every click
 * locally. Same contract as the in-browser encoder, so the tool cannot tell.
 */
export function createRemoteEncoder(options: RemoteEncoderOptions): SegmentationEncoder<SamEmbedding> {
  const doFetch = options.fetch ?? fetch;
  const adapter = adapterFor(options.family);
  return {
    inputSize: options.inputSize,
    async encode(view: EncodeView, signal): Promise<EncodedView<SamEmbedding>> {
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
      const tensors = adapter.embeddingNames.map((name) => {
        const b = blobs.find((x) => x.name === name);
        if (!b || !(b.data instanceof Float32Array)) throw new Error(`remote embedding lacks '${name}'`);
        return { name, dims: b.dims, data: b.data };
      });
      const embedding: SamEmbedding = {
        family: options.family,
        frame: modelFrame(view, options.inputSize, adapter.layout),
        tensors,
      };
      return {
        view,
        embedding,
        bytes: embeddingBytes(embedding),
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

interface SegmentMeta {
  readonly view: EncodeView;
  readonly candidates: readonly { readonly predictedIou: number; readonly frame: RasterFrame }[];
  readonly cached?: boolean;
  readonly timings?: Record<string, number>;
}

export interface RemoteProviderOptions {
  /** POST endpoint; receives `{ target, prompt }`, returns candidates in the wire format. */
  readonly url: string;
  readonly capabilities: ProviderCapabilities;
  readonly fetch?: typeof fetch | undefined;
}

/**
 * All on the server (the MONAI Label / nnInteractive shape): every prompt is
 * a round trip and the server keeps whatever session state it needs. The
 * result is the same {@link MaskCandidate} rasters, so the tool and the
 * mask/polygon conversion are unchanged.
 */
export function createRemoteSegmentationProvider(options: RemoteProviderOptions): SegmentationProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    capabilities: options.capabilities,
    async segment(target, prompt, signal) {
      const t0 = performance.now();
      const body = JSON.stringify({
        target,
        prompt: { points: prompt.points, box: prompt.box },
      });
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
      if (!res.ok) throw new Error(`remote segment failed: HTTP ${res.status} ${await res.text()}`);
      const buffer = await res.arrayBuffer();
      const t1 = performance.now();
      const { blobs, meta } = decodeWire<SegmentMeta>(buffer);
      const candidates: MaskCandidate[] = meta.candidates.map((c, i) => ({
        predictedIou: c.predictedIou,
        mask: { frame: c.frame, data: blobs[i]!.data },
      }));
      return {
        candidates,
        view: meta.view,
        cached: meta.cached,
        timings: { ...meta.timings, roundTrip: t1 - t0, wireBytes: buffer.byteLength },
      };
    },
  };
}
