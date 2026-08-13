import type { SegmentationEncoder, SegmentationImageRef } from '@osdlabel/segmentation';
import type { SamEmbedding } from './sam-embedding.js';

/**
 * Default JSON wire format for the embedding endpoint. The `embedding` field is
 * the `[1,256,64,64]` float32 tensor encoded as base64 (little-endian). This is
 * simple for a reference; production servers should prefer a binary body and a
 * custom {@link RemoteEmbeddingEncoderConfig.parse}.
 */
export interface EmbeddingResponseBody {
  readonly dims: readonly number[];
  readonly origWidth: number;
  readonly origHeight: number;
  readonly inputSize: number;
  readonly embedding: string;
}

export interface RemoteEmbeddingEncoderConfig {
  /** URL the encoder POSTs `{ imageId, tileSource }` to. */
  readonly endpoint: string;
  /** Override the `fetch` implementation (tests, custom auth). */
  readonly fetch?: typeof fetch;
  /** Extra request headers (e.g. authorization). */
  readonly headers?: Record<string, string>;
  /** Override response parsing (e.g. to read a binary `ArrayBuffer` body). */
  readonly parse?: (response: Response, signal: AbortSignal) => Promise<SamEmbedding>;
}

/**
 * A {@link SegmentationEncoder} that delegates the heavy image encode to a
 * server: it POSTs the image reference and parses the returned embedding tensor.
 * The server is a black box — it owns the model and the full-resolution pixels.
 */
export class RemoteEmbeddingEncoder implements SegmentationEncoder<SamEmbedding> {
  private readonly config: RemoteEmbeddingEncoderConfig;

  constructor(config: RemoteEmbeddingEncoderConfig) {
    this.config = config;
  }

  async encode(image: SegmentationImageRef, signal: AbortSignal): Promise<SamEmbedding> {
    const doFetch = this.config.fetch ?? globalThis.fetch;
    const response = await doFetch(this.config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.config.headers },
      body: JSON.stringify({ imageId: image.imageId, tileSource: image.tileSource }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`);
    }
    return (this.config.parse ?? defaultParse)(response, signal);
  }
}

async function defaultParse(response: Response): Promise<SamEmbedding> {
  const body = (await response.json()) as EmbeddingResponseBody;
  return {
    embedding: { data: base64ToFloat32(body.embedding), dims: body.dims },
    origWidth: body.origWidth,
    origHeight: body.origHeight,
    inputSize: body.inputSize,
  };
}

function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
