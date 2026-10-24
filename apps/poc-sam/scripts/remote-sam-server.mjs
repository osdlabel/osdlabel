/* global performance -- Node >= 16 global. */
// The "server" half of the remote topologies, as Vite middleware (one process
// for the harness). Real deployments would be a Python service (MONAI Label,
// nnInteractive, a SAM server); what matters here is the contract and the
// costs on the wire, not the server language.
//
//   POST /api/sam/encode   { view, dtype?, model? } -> embedding (wire format)
//        server encodes, browser decodes (SegmentationEncoder over HTTP)
//   POST /api/sam/segment  { target, prompt, model? } -> candidates (wire format)
//        everything on the server (SegmentationProvider over HTTP)
//
// Pixels come from the server's own copy of the image (here: the same
// synthetic DZI tiles, decoded from PNG), never from the browser.
// Inference uses onnxruntime-node (native CPU), with the same model adapters
// the browser uses (@osdlabel/segmentation-onnx), so the numbers isolate
// topology rather than code differences.
import ort from 'onnxruntime-node';
import { planRegionRead } from '@osdlabel/region-reader';
import { composeSegmentationProvider, modelFrame } from '@osdlabel/segmentation';
import { OnnxSamModel, createOnnxDecoder, embeddingBytes } from '@osdlabel/segmentation-onnx';
import { encodeWire, float16ToFloat32, float32ToFloat16 } from '@osdlabel/segmentation-remote';
import { SYNTH, decodePng, tileBytes } from './synth-tiles.mjs';

import { modelById, modelPaths } from './model-table.mjs';

const SYNTH_PYRAMID = {
  kind: 'dzi',
  width: SYNTH.width,
  height: SYNTH.height,
  tileSize: SYNTH.tileSize,
  overlap: SYNTH.overlap,
  tileUrlTemplate: '{level}/{x}_{y}',
};

/** onnxruntime-node adapted to @osdlabel/segmentation-onnx's OrtModuleLike. */
export function nodeOrt(threads) {
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

/** Reads a region of the synthetic DZI at out size: tiles -> level buffer -> bilinear resample. */
export function readSynthRegion(region, outW, outH) {
  const plan = planRegionRead(SYNTH_PYRAMID, region, outW, outH);
  const LW = plan.levelRect.width;
  const LH = plan.levelRect.height;
  const level = new Uint8Array(LW * LH * 4);
  for (const t of plan.tiles) {
    const [, tx, ty] = [t.level, t.tx, t.ty];
    const img = decodePng(tileBytes(t.level, tx, ty));
    for (let r = 0; r < t.h; r++) {
      const src = ((t.sy + r) * img.width + t.sx) * 4;
      level.set(img.data.subarray(src, src + t.w * 4), ((t.dy + r) * LW + t.dx) * 4);
    }
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = plan.crop.width / outW;
  const sy = plan.crop.height / outH;
  for (let y = 0; y < outH; y++) {
    const fy = Math.min(LH - 1, Math.max(0, plan.crop.y + (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(LH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < outW; x++) {
      const fx = Math.min(LW - 1, Math.max(0, plan.crop.x + (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(LW - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = level[(y0 * LW + x0) * 4 + c];
        const b = level[(y0 * LW + x1) * 4 + c];
        const d = level[(y1 * LW + x0) * 4 + c];
        const e = level[(y1 * LW + x1) * 4 + c];
        out[o + c] = (a + (b - a) * wx) * (1 - wy) + (d + (e - d) * wx) * wy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out, tiles: plan.tiles.length, level: plan.level };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function remoteSamMiddleware(prefix, { modelsDir, threads = 4 }) {
  const models = new Map();
  const providers = new Map();
  const runtime = nodeOrt(threads);

  const getModel = (id) => {
    const spec = modelById(id);
    if (!models.has(id)) {
      const files = modelPaths(spec, modelsDir);
      if (!files) throw new Error(`model files for ${id} missing (run fetch-models)`);
      models.set(
        id,
        OnnxSamModel.load(runtime, { family: spec.family, inputSize: spec.inputSize, ...files }),
      );
    }
    return models.get(id);
  };

  const encodeView = async (model, view) => {
    if (view.imageKey !== 'synth') throw new Error(`server has no image '${view.imageKey}'`);
    const frame = modelFrame(view, model.inputSize, model.adapter.layout);
    const t0 = performance.now();
    const pixels = readSynthRegion(view.region, frame.contentWidth, frame.contentHeight);
    const t1 = performance.now();
    const { embedding, timings } = await model.encode(pixels, frame);
    return {
      embedding,
      timings: {
        serverRead: t1 - t0,
        serverPreprocess: timings.preprocess,
        serverEncode: timings.encode,
      },
    };
  };

  const getProvider = async (id) => {
    if (!providers.has(id)) {
      const model = await getModel(id);
      const encoder = {
        inputSize: model.inputSize,
        async encode(view) {
          const { embedding, timings } = await encodeView(model, view);
          return { view, embedding, bytes: embeddingBytes(embedding), timings };
        },
      };
      providers.set(id, composeSegmentationProvider(encoder, createOnnxDecoder(model)));
    }
    return providers.get(id);
  };

  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(prefix) || req.method !== 'POST') return next();
    const route = url.slice(prefix.length);
    (async () => {
      const body = JSON.parse(await readBody(req));
      const modelId = body.model ?? 'mobile_sam';
      let bytes;
      if (route === 'encode') {
        const model = await getModel(modelId);
        const { embedding, timings } = await encodeView(model, body.view);
        const dtype = body.dtype === 'float32' ? 'float32' : 'float16';
        const t0 = performance.now();
        bytes = encodeWire(
          embedding.tensors.map((t) => ({ name: t.name, dims: t.dims, data: t.data, dtype })),
          { timings: { ...timings, serverSerialize: 0 } },
        );
        const serialize = performance.now() - t0;
        // Re-encode the header with the measured serialisation time is not worth
        // it; report it out of band.
        res.setHeader('x-server-serialize-ms', serialize.toFixed(2));
      } else if (route === 'segment') {
        const provider = await getProvider(modelId);
        const result = await provider.segment(
          body.target,
          body.prompt,
          new AbortController().signal,
        );
        bytes = encodeWire(
          result.candidates.map((c, i) => ({
            name: `c${i}`,
            dims: [c.mask.frame.height, c.mask.frame.width],
            data: c.mask.data,
            dtype: c.mask.data instanceof Float32Array ? 'float16' : 'uint8',
          })),
          {
            view: result.view,
            cached: result.cached,
            timings: result.timings,
            candidates: result.candidates.map((c) => ({
              predictedIou: c.predictedIou,
              frame: c.mask.frame,
            })),
          },
        );
      } else if (route === 'f16check') {
        // Does shipping the embedding as float16 change the mask?
        const model = await getModel(modelId);
        const { embedding } = await encodeView(model, body.view);
        const half = {
          ...embedding,
          tensors: embedding.tensors.map((t) => ({
            ...t,
            data: float16ToFloat32(float32ToFloat16(t.data)),
          })),
        };
        const a = await model.decode(embedding, body.prompt);
        const b = await model.decode(half, body.prompt);
        const perCandidate = a.candidates.map((ca, i) => {
          const x = ca.mask.data;
          const y = b.candidates[i].mask.data;
          let inter = 0;
          let union = 0;
          let maxDiff = 0;
          for (let k = 0; k < x.length; k++) {
            const p = x[k] > 0;
            const q = y[k] > 0;
            if (p && q) inter++;
            if (p || q) union++;
            maxDiff = Math.max(maxDiff, Math.abs(x[k] - y[k]));
          }
          return {
            iou: union ? inter / union : 1,
            maxLogitDiff: maxDiff,
            iouPred: [ca.predictedIou, b.candidates[i].predictedIou],
          };
        });
        const json = JSON.stringify({ perCandidate });
        res.setHeader('Content-Type', 'application/json');
        res.end(json);
        return;
      } else {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', bytes.byteLength);
      res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    })().catch((e) => {
      res.statusCode = 500;
      res.end(String(e?.stack ?? e));
    });
  };
}
