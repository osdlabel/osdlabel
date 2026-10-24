/**
 * The worker that hosts inference: ONNX Runtime, the tile reads and the
 * embedding cache all live here, so the main thread (OSD, Fabric, the UI)
 * never stalls on a multi-second encode.
 */
import { browserTileIO, type TilePyramid } from '@osdlabel/region-reader';
import { composeSegmentationProvider, type EncodePolicy } from '@osdlabel/segmentation';
import {
  OnnxSamModel,
  createOnnxDecoder,
  createOnnxEncoder,
  createRemoteEncoder,
  serveSegmentationWorker,
  type MessagePortLike,
  type ModelFamily,
} from '@osdlabel/segmentation-onnx';
import { loadOrt, type ExecutionProvider } from './ort-runtime.js';

export interface SamWorkerConfig {
  readonly family: ModelFamily;
  readonly inputSize: number;
  readonly encoderUrl: string;
  readonly decoderUrl: string;
  readonly ep: ExecutionProvider;
  readonly threads: number;
  /** `remote-encoder`: the server encodes, this worker only decodes. */
  readonly mode: 'local' | 'remote-encoder';
  readonly remoteUrl?: string | undefined;
  readonly remoteModel?: string | undefined;
  readonly pyramids: Readonly<Record<string, TilePyramid>>;
  readonly policy?: Partial<EncodePolicy> | undefined;
}

const scope = self as unknown as MessagePortLike;

serveSegmentationWorker<SamWorkerConfig>(scope, async (config) => {
  const { ort } = await loadOrt(config.ep, config.threads);
  const pyramids = new Map(Object.entries(config.pyramids));
  const model = await OnnxSamModel.load(
    ort,
    {
      family: config.family,
      inputSize: config.inputSize,
      encoder: config.mode === 'local' ? config.encoderUrl : undefined,
      decoder: config.decoderUrl,
    },
    {
      encoderSession: { executionProviders: [config.ep] },
      decoderSession: { executionProviders: ['wasm'] },
    },
  );
  const encoder =
    config.mode === 'local'
      ? createOnnxEncoder(model, (key) => pyramids.get(key), browserTileIO())
      : createRemoteEncoder({
          url: config.remoteUrl ?? '/api/sam/encode',
          family: config.family,
          inputSize: config.inputSize,
          fetch: (input, init) => {
            // Tell the server which model to run.
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
            return fetch(input, {
              ...init,
              body: JSON.stringify({ ...body, model: config.remoteModel }),
            });
          },
        });
  const provider = composeSegmentationProvider(encoder, createOnnxDecoder(model), {
    policy: config.policy,
  });
  return {
    provider,
    info: { load: model.loadTimings, crossOriginIsolated: globalThis.crossOriginIsolated },
    configure(message: unknown) {
      const m = message as {
        register?: { key: string; pyramid: TilePyramid };
        cacheStats?: boolean;
      };
      if (m.register) pyramids.set(m.register.key, m.register.pyramid);
      return { cacheEntries: provider.cache.size, cacheBytes: provider.cache.bytes };
    },
  };
});
