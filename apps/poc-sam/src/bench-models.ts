/**
 * H1: encoder / decoder latency per model, execution provider and thread
 * count, in the browser. One page load measures one configuration (the
 * runner opens a fresh page per configuration so WASM heaps and thread pools
 * never carry over).
 */
import { modelFrame, type SegmentationPrompt } from '@osdlabel/segmentation';
import { OnnxSamModel, embeddingBytes } from '@osdlabel/segmentation-onnx';
import { findSpec, modelUrl } from './model-specs.js';
import { loadOrt, webgpuAdapterInfo, type ExecutionProvider } from './ort-runtime.js';
import { stats, type Stats } from './stats.js';

export interface ModelBenchConfig {
  readonly model: string;
  /** Execution provider for the encoder and the decoder (they may differ). */
  readonly encoderEp: ExecutionProvider;
  readonly decoderEp: ExecutionProvider;
  readonly threads: number;
  /** 0 measures the decoder only (one untimed encode produces its embedding). */
  readonly encoderReps: number;
  readonly decoderReps: number;
}

export interface ModelBenchResult {
  readonly config: ModelBenchConfig;
  readonly env: Record<string, unknown>;
  readonly load: Readonly<Record<string, number>>;
  readonly firstEncode: number;
  readonly preprocess: Stats;
  readonly encode: Stats;
  readonly decodeClick: Stats;
  readonly decodeBoxPoints: Stats;
  readonly decodeOutputs: Stats;
  readonly embeddingBytes: number;
  readonly error?: string;
}

function noiseImage(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    d[i] = (i & 3) === 3 ? 255 : s >>> 24;
  }
  return d;
}

async function run(cfg: ModelBenchConfig): Promise<ModelBenchResult> {
  const spec = findSpec(cfg.model);
  const env = {
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    webgpu: cfg.encoderEp === 'webgpu' || cfg.decoderEp === 'webgpu' ? await webgpuAdapterInfo() : null,
  };
  const build: ExecutionProvider = cfg.encoderEp === 'webgpu' || cfg.decoderEp === 'webgpu' ? 'webgpu' : 'wasm';
  const { ort } = await loadOrt(build, cfg.threads);
  const model = await OnnxSamModel.load(
    ort,
    {
      family: spec.family,
      inputSize: spec.inputSize,
      encoder: await modelUrl(spec.encoder),
      decoder: await modelUrl(spec.decoder, spec.decoderFallback),
    },
    {
      encoderSession: { executionProviders: [cfg.encoderEp] },
      decoderSession: { executionProviders: [cfg.decoderEp] },
    },
  );
  const S = spec.inputSize;
  const view = {
    imageKey: 'bench',
    imageSize: { width: S, height: S },
    region: { x: 0, y: 0, width: S, height: S },
    scale: 1,
  };
  const frame = modelFrame(view, S, model.adapter.layout);
  const pixels = { width: frame.contentWidth, height: frame.contentHeight, data: noiseImage(frame.contentWidth, frame.contentHeight) };

  if (cfg.encoderEp === 'webgpu' && cfg.decoderEp === 'webgpu') throw new Error('measure WebGPU one half at a time');
  const t0 = performance.now();
  let { embedding } = await model.encode(pixels, frame);
  const firstEncode = performance.now() - t0;
  window.__benchProgress = { firstEncode, load: model.loadTimings };
  const pre: number[] = [];
  const enc: number[] = [];
  for (let i = 0; i < cfg.encoderReps; i++) {
    const r = await model.encode(pixels, frame);
    embedding = r.embedding;
    pre.push(r.timings['preprocess']!);
    enc.push(r.timings['encode']!);
  }

  const click: SegmentationPrompt = { points: [{ x: S * 0.4, y: S * 0.55, label: 1 }] };
  const boxPoints: SegmentationPrompt = {
    box: { x: S * 0.2, y: S * 0.3, width: S * 0.4, height: S * 0.35 },
    points: [
      { x: S * 0.4, y: S * 0.5, label: 1 },
      { x: S * 0.25, y: S * 0.35, label: 0 },
    ],
  };
  const dClick: number[] = [];
  const dBox: number[] = [];
  const dOut: number[] = [];
  for (let i = 0; i < 3; i++) await model.decode(embedding, click); // warm-up
  for (let i = 0; i < cfg.decoderReps; i++) {
    const a = await model.decode(embedding, click);
    dClick.push(a.timings['decode']!);
    dOut.push(a.timings['decodeOutputs']!);
    const b = await model.decode(embedding, boxPoints);
    dBox.push(b.timings['decode']!);
  }
  await model.release();
  return {
    config: cfg,
    env,
    load: model.loadTimings,
    firstEncode,
    preprocess: stats(pre),
    encode: stats(enc),
    decodeClick: stats(dClick),
    decodeBoxPoints: stats(dBox),
    decodeOutputs: stats(dOut),
    embeddingBytes: embeddingBytes(embedding),
  };
}

declare global {
  interface Window {
    __runModelBench?: (cfg: ModelBenchConfig) => Promise<ModelBenchResult | { config: ModelBenchConfig; error: string }>;
    /** Partial results, readable by the runner when a configuration times out. */
    __benchProgress?: Record<string, unknown>;
  }
}

window.__runModelBench = async (cfg) => {
  try {
    return await run(cfg);
  } catch (e) {
    return { config: cfg, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
};

const status = document.getElementById('status');
if (status) status.textContent = `ready (crossOriginIsolated=${String(globalThis.crossOriginIsolated)})`;
