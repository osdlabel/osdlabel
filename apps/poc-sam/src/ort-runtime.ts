import type * as Ort from 'onnxruntime-web';
import type { OrtModuleLike, OrtSessionLike } from '@osdlabel/segmentation-onnx';

export type ExecutionProvider = 'wasm' | 'webgpu';

/**
 * Loads the onnxruntime-web build for `ep` and adapts it to the structural
 * interface `@osdlabel/segmentation-onnx` uses. The WASM-only build is used
 * for `wasm` so its numbers are not affected by the WebGPU build's extra
 * runtime (JSEP/asyncify).
 */
export async function loadOrt(
  ep: ExecutionProvider,
  threads: number,
): Promise<{ ort: OrtModuleLike<Ort.Tensor>; raw: typeof Ort }> {
  const raw: typeof Ort =
    ep === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  raw.env.wasm.wasmPaths = '/ort/';
  raw.env.wasm.numThreads = threads;
  raw.env.wasm.proxy = false;
  raw.env.logLevel = 'error';
  const wrap = (s: Ort.InferenceSession): OrtSessionLike<Ort.Tensor> => ({
    inputNames: s.inputNames,
    outputNames: s.outputNames,
    async run(feeds, fetches) {
      const out = fetches ? await s.run(feeds, fetches) : await s.run(feeds);
      const result: Record<string, Ort.Tensor> = {};
      for (const [k, v] of Object.entries(out)) result[k] = v;
      return result;
    },
    release: () => s.release(),
  });
  const ort: OrtModuleLike<Ort.Tensor> = {
    async createSession(model, options) {
      const opts: Ort.InferenceSession.SessionOptions = {
        executionProviders: [...(options?.executionProviders ?? [ep])],
        graphOptimizationLevel: options?.graphOptimizationLevel ?? 'all',
      };
      const s =
        typeof model === 'string'
          ? await raw.InferenceSession.create(model, opts)
          : await raw.InferenceSession.create(model, opts);
      return wrap(s);
    },
    float32: (data, dims) => new raw.Tensor('float32', data, dims),
    int64: (data, dims) => new raw.Tensor('int64', data, dims),
  };
  return { ort, raw };
}

export async function webgpuAdapterInfo(): Promise<Record<string, string> | null> {
  const gpu = (
    navigator as Navigator & {
      gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> };
    }
  ).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const info = adapter.info ?? {};
  return {
    vendor: info['vendor'] ?? '',
    architecture: info['architecture'] ?? '',
    description: info['description'] ?? '',
  };
}
