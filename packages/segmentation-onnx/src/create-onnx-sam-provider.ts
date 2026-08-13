import { composeSegmentationProvider } from '@osdlabel/segmentation';
import type { SegmentationProvider } from '@osdlabel/segmentation';
import { RemoteEmbeddingEncoder } from './remote-embedding-encoder.js';
import type { RemoteEmbeddingEncoderConfig } from './remote-embedding-encoder.js';
import { OnnxSamDecoder } from './onnx-sam-decoder.js';
import type { OnnxSamDecoderConfig } from './onnx-sam-decoder.js';
import { createOrtSession } from './ort-session.js';
import type { CreateOrtSessionOptions } from './ort-session.js';

export interface CreateOnnxSamProviderConfig {
  /** Remote image-encoder endpoint configuration. */
  readonly encoder: RemoteEmbeddingEncoderConfig;
  /** In-browser ONNX decoder configuration. */
  readonly decoder: Omit<OnnxSamDecoderConfig, 'createSession'> & {
    /** URL of the SAM/MobileSAM decoder `.onnx`. */
    readonly modelUrl: string;
    /** ORT session options (execution providers, `wasmPaths`). */
    readonly session?: CreateOrtSessionOptions;
  };
}

/**
 * Convenience factory for the server-encode → client-decode topology: composes a
 * {@link RemoteEmbeddingEncoder} with an {@link OnnxSamDecoder} (backed by
 * {@link createOrtSession}) into a ready-to-inject {@link SegmentationProvider}.
 *
 * For finer control (e.g. a custom session, a shared decoder), construct the
 * encoder/decoder yourself and call `composeSegmentationProvider` directly.
 */
export function createOnnxSamProvider(config: CreateOnnxSamProviderConfig): SegmentationProvider {
  const { modelUrl, session, ...decoderConfig } = config.decoder;
  const encoder = new RemoteEmbeddingEncoder(config.encoder);
  const decoder = new OnnxSamDecoder({
    ...decoderConfig,
    createSession: () => createOrtSession(modelUrl, session),
  });
  return composeSegmentationProvider(encoder, decoder);
}
