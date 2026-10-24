/* global performance -- Node >= 16 global. */
/**
 * Mask quality across model variants (H7 int8) and refinement across a view
 * change (H2 / review finding B3), on onnxruntime-web's WASM kernels.
 *
 *   node scripts/quality-check.mjs [--models mobile_sam,mobile_sam_enc_int8,...]
 *        [--steps S2,R1,R2,R3] [--runtime web|node] [--threads 1]
 *        [--previous-mask resample|drop] [--out results/quality-<stamp>.json]
 *
 * Walks the e2e scenario (scripts/scenario.mjs) through the same provider the
 * browser uses — composeSegmentationProvider over the @osdlabel/segmentation-onnx
 * adapters, with the synthetic DZI read in this process — once per model
 * variant, keeping the tool's prompt semantics (points accumulate across
 * `keep` steps, and the previous best candidate is fed back as mask_input).
 * Per step it records the cache verdict, the encoded view, the ranked
 * candidates and the best candidate's ground-truth IoU. Then:
 *
 * - every variant's best mask against its fp32 reference (model-table.json
 *   `reference`, else the first model), in image space, on the same prompts;
 * - every refinement step (a step after a `keep` step) against the step
 *   before it: IoU and centroid shift of the two best masks, and how the
 *   previous logits line up with the new embedding's grid when resampled
 *   (what the decoder is fed now) or copied cell for cell (what it was fed
 *   before the fix).
 *
 * `--runtime web` (default) runs onnxruntime-web's WASM build in Node: the
 * same kernels the browser runs, so int8 rounding matches the browser's
 * (native x86 int8 kernels differ). `--runtime node` uses onnxruntime-node.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryIou, fillRings } from '@osdlabel/mask-contour';
import {
  composeSegmentationProvider,
  modelFrame,
  rankCandidates,
  rasterToMaskSnapshot,
  resampleLogits,
} from '@osdlabel/segmentation';
import { OnnxSamModel, createOnnxDecoder, embeddingBytes } from '@osdlabel/segmentation-onnx';
import { MODELS_DIR, modelById, modelPaths } from './model-table.mjs';
import { nodeOrt, readSynthRegion } from './remote-sam-server.mjs';
import { scenarioSteps, targetForView } from './scenario.mjs';
import { SYNTH } from './synth-tiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const REQUESTED = arg(
  '--models',
  'mobile_sam,mobile_sam_enc_int8,mobile_sam_enc_int8mm,mobile_sam_enc_qdq,mobile_sam_dec_int8,mobile_sam_fulldec,mobile_sam_int8',
)
  .split(',')
  .filter(Boolean);
/** Each variant is compared with its fp32 reference, which must run first. */
const referenceOf = (id) => modelById(id).reference ?? REQUESTED[0];
const MODELS = [];
for (const id of REQUESTED) {
  if (!modelPaths(modelById(id), MODELS_DIR)) {
    console.warn(`skip ${id}: model files missing (fetch-models derives them)`);
    continue;
  }
  const ref = referenceOf(id);
  if (ref !== id && !MODELS.includes(ref)) MODELS.push(ref);
  if (!MODELS.includes(id)) MODELS.push(id);
}
const RUNTIME = arg('--runtime', 'web');
const STEPS = arg('--steps', null)?.split(',') ?? null;
const THREADS = Number(arg('--threads', RUNTIME === 'web' ? '1' : '4'));
/** 'resample' (default) or 'drop': a previous mask from another grid (see PreviousMaskAlignment). */
const PREVIOUS_MASK = arg('--previous-mask', 'resample');
const OUT = arg(
  '--out',
  path.join(
    HERE,
    '..',
    'results',
    `quality-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  ),
);
const IMAGE = { width: SYNTH.width, height: SYNTH.height };
const CAP = 128 * 1024 * 1024;

/** onnxruntime-web (WASM, in Node) adapted to OrtModuleLike: the browser's kernels. */
async function webOrt(threads) {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  return {
    async createSession(model) {
      const s = await ort.InferenceSession.create(model, {
        executionProviders: ['wasm'],
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

/** Foreground centroid of a snapshot, in image px. */
function centroid(snap) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let r = 0; r < snap.height; r++) {
    for (let c = 0; c < snap.width; c++) {
      if (!snap.data[r * snap.width + c]) continue;
      n++;
      sx += c;
      sy += r;
    }
  }
  return n ? { x: snap.x + sx / n + 0.5, y: snap.y + sy / n + 0.5, pixels: n } : null;
}

/**
 * A refinement step against the step it refines: do the two best masks agree
 * (IoU, centroid shift), and how does the previous result line up with the
 * new embedding's low-res grid — resampled (what the decoder is fed now) or
 * copied cell for cell from index (0, 0) (what maskInputFeeds did before the
 * fix, whenever the previous grid fitted 256 x 256)?
 */
function refinementAlignment(prevBest, prevSnap, best, snap) {
  const out = { bestMaskIoU: snapIou(snap, prevSnap) };
  const c0 = prevSnap ? centroid(prevSnap) : null;
  const c1 = snap ? centroid(snap) : null;
  if (c0 && c1) {
    out.centroidShiftPx = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    out.previousCellPx = prevBest.mask.frame.pixelWidth;
    out.newCellPx = best.mask.frame.pixelWidth;
  }
  const P = prevBest.mask;
  const G = best.mask.frame; // the new embedding's grid (content crop)
  const resampled = { frame: G, data: resampleLogits(P.data, P.frame, G) };
  const copied = {
    frame: { ...G, width: P.frame.width, height: P.frame.height },
    data: P.data,
  };
  const rs = snapshotOf({ mask: resampled });
  const cp = snapshotOf({ mask: copied });
  out.previousResampledIoU = snapIou(rs, prevSnap);
  out.previousCopiedIoU = snapIou(cp, prevSnap);
  const cr = rs ? centroid(rs) : null;
  const cc = cp ? centroid(cp) : null;
  if (c0 && cr) out.previousResampledShiftPx = Math.hypot(cr.x - c0.x, cr.y - c0.y);
  if (c0 && cc) out.previousCopiedShiftPx = Math.hypot(cc.x - c0.x, cc.y - c0.y);
  return out;
}

function ellipseRing(gt, n = 256) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: gt.x + gt.rx * Math.cos(a), y: gt.y + gt.ry * Math.sin(a) };
  });
}

/** A best candidate as a full-resolution snapshot, or null when it is too large to measure. */
function snapshotOf(candidate) {
  try {
    return rasterToMaskSnapshot(candidate.mask, IMAGE, { maxPixels: CAP });
  } catch {
    return null;
  }
}

/** Pastes `snap` into a w x h buffer whose origin is (x0, y0). */
function paste(snap, x0, y0, w, h) {
  const out = new Uint8Array(w * h);
  for (let r = 0; r < snap.height; r++) {
    out.set(
      snap.data.subarray(r * snap.width, (r + 1) * snap.width),
      (snap.y - y0 + r) * w + (snap.x - x0),
    );
  }
  return out;
}

function gtIou(snap, gt) {
  if (!snap || gt.kind !== 'ellipse') return null;
  const x0 = Math.floor(Math.min(snap.x, gt.x - gt.rx));
  const y0 = Math.floor(Math.min(snap.y, gt.y - gt.ry));
  const x1 = Math.ceil(Math.max(snap.x + snap.width, gt.x + gt.rx));
  const y1 = Math.ceil(Math.max(snap.y + snap.height, gt.y + gt.ry));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w * h > CAP) return null;
  return binaryIou(paste(snap, x0, y0, w, h), fillRings([ellipseRing(gt)], w, h, x0, y0));
}

/** The raster's value at image point `p` (nearest cell), or -Infinity outside it. */
function logitAt(mask, p) {
  const f = mask.frame;
  const u = Math.floor((p.x - f.originX) / f.pixelWidth);
  const v = Math.floor((p.y - f.originY) / f.pixelHeight);
  if (u < 0 || v < 0 || u >= f.width || v >= f.height) return -Infinity;
  return mask.data[v * f.width + u];
}

/** IoU of two full-resolution snapshots, in image space. */
function snapIou(a, b) {
  if (!a || !b) return null;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const w = Math.max(a.x + a.width, b.x + b.width) - x0;
  const h = Math.max(a.y + a.height, b.y + b.height) - y0;
  if (w * h > CAP) return null;
  return binaryIou(paste(a, x0, y0, w, h), paste(b, x0, y0, w, h));
}

/** IoU of two low-res candidates on the same grid (logits > 0), or null. */
function gridIou(a, b) {
  const fa = a.mask.frame;
  const fb = b.mask.frame;
  if (fa.width !== fb.width || fa.height !== fb.height || fa.originX !== fb.originX) return null;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.mask.data.length; i++) {
    const p = a.mask.data[i] > 0;
    const q = b.mask.data[i] > 0;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union ? inter / union : 1;
}

async function runModel(id) {
  const spec = modelById(id);
  const files = modelPaths(spec, MODELS_DIR);
  if (!files) throw new Error(`model files for ${id} missing`);
  const model = await OnnxSamModel.load(
    RUNTIME === 'web' ? await webOrt(THREADS) : nodeOrt(THREADS),
    { family: spec.family, inputSize: spec.inputSize, ...files },
    { previousMask: PREVIOUS_MASK },
  );
  const encoder = {
    inputSize: model.inputSize,
    async encode(view) {
      const frame = modelFrame(view, model.inputSize, model.adapter.layout);
      const t0 = performance.now();
      const pixels = readSynthRegion(view.region, frame.contentWidth, frame.contentHeight);
      const t1 = performance.now();
      const { embedding, timings } = await model.encode(pixels, frame);
      return {
        view,
        embedding,
        bytes: embeddingBytes(embedding),
        timings: { read: t1 - t0, ...timings },
      };
    },
  };
  const provider = composeSegmentationProvider(encoder, createOnnxDecoder(model));
  const signal = new AbortController().signal;
  const steps = scenarioSteps(STEPS);
  const out = [];
  let points = [];
  let best = null;
  let bestSnap = null;
  let target = null;
  for (const step of steps) {
    if (step.view) target = targetForView(step.view, IMAGE);
    points.push({ ...step.click, label: 1 });
    const prompt = {
      points: [...points],
      ...(best && points.length > 1 ? { previous: best.mask } : {}),
    };
    const result = await provider.segment(target, prompt, signal);
    const ranked = rankCandidates(result.candidates, 'iou');
    const prevBest = prompt.previous ? best : null;
    const prevSnap = bestSnap;
    best = ranked[0] ?? null;
    const snap = best ? snapshotOf(best) : null;
    bestSnap = snap;
    const r = result.view.region;
    out.push({
      id: step.id,
      cached: result.cached,
      region: r,
      scale: result.view.scale,
      encodeMs: result.timings?.encode,
      decodeMs: result.timings?.decode,
      maskInput: result.timings?.maskInput ?? 0,
      promptPoints: points.length,
      promptInsideRegion: points.every(
        (p) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height,
      ),
      predictedIou: ranked.map((c) => c.predictedIou),
      groundTruthIoU: gtIou(snap, step.gt),
      altGroundTruthIoU: step.altGt ? gtIou(snap, step.altGt) : undefined,
      candidatesGroundTruthIoU:
        step.gt.kind === 'ellipse' ? ranked.map((c) => gtIou(snapshotOf(c), step.gt)) : undefined,
      // How many of the prompt's (positive) points each candidate covers.
      candidatesCoverPoints: ranked.map((c) => points.filter((p) => logitAt(c.mask, p) > 0).length),
      refinement:
        prevBest && best ? refinementAlignment(prevBest, prevSnap, best, snap) : undefined,
      _ranked: ranked,
      _cands: result.candidates,
      _snap: snap,
    });
    if (!step.keep) {
      points = [];
      best = null;
      bestSnap = null;
    }
  }
  return { model: id, steps: out, cacheEntries: provider.cache.size };
}

const f = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '-');

async function main() {
  const runs = [];
  for (const id of MODELS) {
    const t0 = Date.now();
    const run = await runModel(id);
    runs.push(run);
    console.log(
      `\n[${id}] ${((Date.now() - t0) / 1000).toFixed(0)} s, load1 ${os.loadavg()[0].toFixed(1)}`,
    );
    for (const s of run.steps) {
      console.log(
        `  ${s.id.padEnd(3)} ${s.cached ? 'HIT ' : 'MISS'} scale ${s.scale.toFixed(4)} ` +
          `enc ${f(s.encodeMs, 0).padStart(5)} dec ${f(s.decodeMs, 0).padStart(4)}${s.maskInput ? ' +mask_input' : ''} | ` +
          `${s.promptPoints} pt ${s.promptInsideRegion ? 'inside' : 'OUTSIDE'} | GT IoU ${f(s.groundTruthIoU)}` +
          `${s.altGroundTruthIoU !== undefined ? `/${f(s.altGroundTruthIoU)}` : ''} | candidates GT ${
            s.candidatesGroundTruthIoU?.map((v) => f(v, 2)).join(' ') ?? '-'
          } | pred ${s.predictedIou.map((v) => f(v, 2)).join(' ')} | covers ${s.candidatesCoverPoints.join(' ')}`,
      );
    }
  }
  // Every variant against the reference (the first model).
  const comparisons = [];
  for (const run of runs) {
    const refId = referenceOf(run.model);
    const ref = runs.find((r) => r.model === refId);
    if (!ref || ref === run) continue;
    const rows = run.steps.map((s, i) => {
      const r = ref.steps[i];
      return {
        id: s.id,
        bestMaskIoU: snapIou(s._snap, r._snap),
        // Per decoder output (not per rank, which can differ between the two).
        candidateGridIoU: s._cands.map((c, k) => (r._cands[k] ? gridIou(c, r._cands[k]) : null)),
        groundTruthIoU: [r.groundTruthIoU, s.groundTruthIoU],
      };
    });
    comparisons.push({ model: run.model, reference: ref.model, rows });
    console.log(
      `\n${run.model} vs ${ref.model}: best-mask IoU (image space) | low-res IoU per decoder output | GT IoU ref -> variant`,
    );
    for (const row of rows) {
      console.log(
        `  ${row.id.padEnd(3)} ${f(row.bestMaskIoU, 4)} | ${row.candidateGridIoU.map((v) => f(v, 3)).join(' ')} | ` +
          `${f(row.groundTruthIoU[0])} -> ${f(row.groundTruthIoU[1])}`,
      );
    }
  }
  // Refinement across a view change: each refinement step against the one before.
  for (const run of runs) {
    const rows = run.steps.filter((s) => s.refinement);
    if (!rows.length) continue;
    console.log(
      `\n${run.model} refinement: best mask vs previous step's (IoU, centroid shift) | previous logits on the new grid: resampled vs copied cell for cell (IoU with the previous mask, centroid shift)`,
    );
    for (const s of rows) {
      const a = s.refinement;
      console.log(
        `  ${s.id.padEnd(3)} IoU ${f(a.bestMaskIoU)} shift ${f(a.centroidShiftPx, 1)} px (cells: prev ${f(a.previousCellPx, 1)} px, new ${f(a.newCellPx, 1)} px) | ` +
          `resampled IoU ${f(a.previousResampledIoU)} shift ${f(a.previousResampledShiftPx, 1)} px | copied IoU ${f(a.previousCopiedIoU)} shift ${f(a.previousCopiedShiftPx, 1)} px`,
      );
    }
  }
  const strip = (run) => ({
    ...run,
    steps: run.steps.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_'))),
    ),
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        meta: {
          at: new Date().toISOString(),
          threads: THREADS,
          previousMask: PREVIOUS_MASK,
          runtime: RUNTIME === 'web' ? 'onnxruntime-web (WASM, Node)' : 'onnxruntime-node',
          loadavg: os.loadavg(),
          cpus: os.cpus().length,
        },
        runs: runs.map(strip),
        comparisons,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
