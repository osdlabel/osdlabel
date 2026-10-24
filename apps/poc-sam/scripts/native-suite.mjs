/* global performance -- Node >= 16 global. */
// H1 baseline: the same models, adapters and protocol as src/bench-models.ts,
// on onnxruntime-node (native CPU, MLAS). This is what a server-side encoder
// on the same machine gets, and the WASM/native ratio is the browser's cost.
// Runs inside the benchmark process, so the comparison is taken minutes, not
// hours, apart (the sandbox's load varies a lot).
import os from 'node:os';
import ort from 'onnxruntime-node';
import { modelFrame } from '@osdlabel/segmentation';
import { OnnxSamModel, embeddingBytes } from '@osdlabel/segmentation-onnx';

function nodeOrt(threads) {
  return {
    async createSession(model) {
      const s = await ort.InferenceSession.create(model, {
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      });
      return {
        inputNames: s.inputNames,
        outputNames: s.outputNames,
        run: (feeds, fetches) => (fetches ? s.run(feeds, fetches) : s.run(feeds)),
        release: () => s.release(),
      };
    },
    float32: (data, dims) => new ort.Tensor('float32', data, dims),
    int64: (data, dims) => new ort.Tensor('int64', data, dims),
  };
}

/** Identical to bench-models.ts's noiseImage (same LCG, same seed). */
function noiseImage(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    d[i] = (i & 3) === 3 ? 255 : s >>> 24;
  }
  return d;
}

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => {
    if (s.length === 0) return NaN;
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, median: r(q(0.5)), min: r(s[0] ?? NaN), max: r(s[s.length - 1] ?? NaN), p90: r(q(0.9)), samples: samples.map(r) };
}

export async function runNativeCase(spec, files, threads, encoderReps, decoderReps) {
  const loadBefore = os.loadavg()[0];
  const model = await OnnxSamModel.load(nodeOrt(threads), { family: spec.family, inputSize: spec.inputSize, ...files });
  const S = spec.inputSize;
  const view = { imageKey: 'bench', imageSize: { width: S, height: S }, region: { x: 0, y: 0, width: S, height: S }, scale: 1 };
  const frame = modelFrame(view, S, model.adapter.layout);
  const pixels = { width: frame.contentWidth, height: frame.contentHeight, data: noiseImage(frame.contentWidth, frame.contentHeight) };
  const t0 = performance.now();
  let { embedding } = await model.encode(pixels, frame);
  const firstEncode = performance.now() - t0;
  const pre = [];
  const enc = [];
  const cpuMs = (u) => (u.user + u.system) / 1000;
  const encCpu0 = process.cpuUsage();
  for (let i = 0; i < encoderReps; i++) {
    const r = await model.encode(pixels, frame);
    embedding = r.embedding;
    pre.push(r.timings.preprocess);
    enc.push(r.timings.encode);
  }
  const click = { points: [{ x: S * 0.4, y: S * 0.55, label: 1 }] };
  const boxPoints = {
    box: { x: S * 0.2, y: S * 0.3, width: S * 0.4, height: S * 0.35 },
    points: [
      { x: S * 0.4, y: S * 0.5, label: 1 },
      { x: S * 0.25, y: S * 0.35, label: 0 },
    ],
  };
  const encCpu = cpuMs(process.cpuUsage(encCpu0));
  for (let i = 0; i < 3; i++) await model.decode(embedding, click);
  const decCpu0 = process.cpuUsage();
  const dClick = [];
  const dBox = [];
  for (let i = 0; i < decoderReps; i++) {
    dClick.push((await model.decode(embedding, click)).timings.decode);
    dBox.push((await model.decode(embedding, boxPoints)).timings.decode);
  }
  const decCpu = cpuMs(process.cpuUsage(decCpu0));
  await model.release();
  return {
    config: { model: spec.id, runtime: `onnxruntime-node ${ort.env.versions?.node ?? ''}`.trim(), threads, encoderReps, decoderReps },
    load: model.loadTimings,
    firstEncode,
    preprocess: stats(pre),
    encode: stats(enc),
    decodeClick: stats(dClick),
    decodeBoxPoints: stats(dBox),
    embeddingBytes: embeddingBytes(embedding),
    // Process CPU (all ORT threads) per call: robust to other load on the machine.
    cpu: {
      encodeMs: encoderReps > 0 ? encCpu / encoderReps : undefined,
      decodeMs: decoderReps > 0 ? decCpu / (2 * decoderReps) : undefined,
    },
    loadavg: [loadBefore, os.loadavg()[0]],
  };
}
