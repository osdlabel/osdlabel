import type * as Ort from 'onnxruntime-web';
import { modelFrame } from '@osdlabel/segmentation';
import {
  OnnxSamModel,
  chooseExecutionProvider,
  type EpGateOptions,
  type EpVerdict,
  type GpuLike,
  type OrtModuleLike,
  type OrtSessionLike,
  type ProbeEp,
} from '@osdlabel/segmentation-onnx';

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

/**
 * The WebGPU gate, as the app runs it: `chooseExecutionProvider` with a probe
 * that times the SAM low-res decoder (one warm-up, then the median of three
 * runs of a one-click prompt on a zero embedding) on each EP of the WebGPU
 * build. The probe only runs on a hardware, non-fallback adapter.
 */
export async function webgpuGate(decoderUrl: string, options?: EpGateOptions): Promise<EpVerdict> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  const probe = async (ep: ProbeEp): Promise<number> => {
    const { ort } = await loadOrt('webgpu', 1);
    const model = await OnnxSamModel.load(
      ort,
      { family: 'sam1', inputSize: 1024, decoder: decoderUrl },
      { decoderSession: { executionProviders: [ep] } },
    );
    const view = {
      imageKey: 'probe',
      imageSize: { width: 1024, height: 1024 },
      region: { x: 0, y: 0, width: 1024, height: 1024 },
      scale: 1,
    };
    const embedding = {
      family: 'sam1' as const,
      frame: modelFrame(view, 1024, 'letterbox'),
      tensors: [
        { name: 'image_embeddings', dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64) },
      ],
    };
    const prompt = { points: [{ x: 400, y: 500, label: 1 as const }] };
    await model.decode(embedding, prompt);
    const times: number[] = [];
    for (let i = 0; i < 3; i++)
      times.push((await model.decode(embedding, prompt)).timings['decode']!);
    await model.release();
    return times.sort((a, b) => a - b)[1]!;
  };
  return chooseExecutionProvider(gpu, probe, options);
}
