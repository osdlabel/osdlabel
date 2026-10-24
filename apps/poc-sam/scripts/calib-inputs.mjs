/**
 * Calibration inputs for static (QDQ) int8 quantisation of a SAM1-family
 * encoder: preprocessed `[1, 3, 1024, 1024]` float32 tensors, one raw file per
 * view, read by scripts/quantize_variants.py.
 *
 *   node scripts/calib-inputs.mjs --out <dir> [--count 12]
 *
 * The views are pseudo-random (fixed seed) crops of the synthetic gigapixel
 * DZI at zooms from overview to 1:1, read and preprocessed exactly as the
 * provider does (planEncodeView -> modelFrame -> region read -> rgbaToChw).
 * They deliberately avoid the e2e scenario's views, so calibration and the
 * quality check (scripts/quality-check.mjs) do not share inputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { modelFrame, planEncodeView } from '@osdlabel/segmentation';
import { rgbaToChw } from '@osdlabel/segmentation-onnx';
import { readSynthRegion } from './remote-sam-server.mjs';
import { scenarioSteps, targetForView } from './scenario.mjs';
import { SYNTH } from './synth-tiles.mjs';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const OUT = arg('--out', null);
if (!OUT) throw new Error('--out <dir> is required');
const COUNT = Number(arg('--count', '12'));
const IMAGE = { width: SYNTH.width, height: SYNTH.height };
const INPUT = 1024;

// Mulberry32: a small deterministic PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scenarioCentres = scenarioSteps()
  .filter((s) => s.view)
  .map((s) => s.view);
const rand = rng(1234);
fs.mkdirSync(OUT, { recursive: true });
let written = 0;
while (written < COUNT) {
  // Zoom from overview (1280 / 40_000) to 1:1, log-uniform.
  const zoom = Math.exp(Math.log(1280 / 40_000) + rand() * Math.log(40_000 / 1280));
  const view = {
    cx: 15_000 + rand() * (IMAGE.width - 30_000),
    cy: 12_000 + rand() * (IMAGE.height - 24_000),
    zoom,
  };
  // Keep away from every scenario view's centre (at that view's scale).
  const near = scenarioCentres.some(
    (v) => Math.hypot(v.cx - view.cx, v.cy - view.cy) < 1280 / Math.min(v.zoom, view.zoom),
  );
  if (near) continue;
  const target = targetForView(view, IMAGE);
  const ev = planEncodeView(target);
  const frame = modelFrame(ev, INPUT, 'letterbox');
  const pixels = readSynthRegion(ev.region, frame.contentWidth, frame.contentHeight);
  const chw = rgbaToChw(pixels, INPUT, 'imagenet');
  const file = path.join(OUT, `calib-${String(written).padStart(2, '0')}.f32`);
  fs.writeFileSync(file, Buffer.from(chw.buffer, chw.byteOffset, chw.byteLength));
  console.log(
    `${path.basename(file)}: centre (${view.cx.toFixed(0)}, ${view.cy.toFixed(0)}) zoom ${zoom.toFixed(4)} scale ${ev.scale.toFixed(4)}`,
  );
  written++;
}
