/* global window -- page.evaluate callbacks run in the browser, not in Node. */
/**
 * The PoC's one-command benchmark.
 *
 *   pnpm --filter @osdlabel/poc-sam bench [-- options]
 *
 * Starts the harness's Vite server (COOP/COEP, models, synthetic gigapixel
 * DZI, remote-encode endpoints), drives headless Chromium through:
 *
 *   native  H1  the same models on onnxruntime-node (server baseline, WASM cost)
 *   models  H1  encoder/decoder latency per model x EP x threads (browser);
 *               WebGPU cases only when the WebGPU gate passes (--force-webgpu)
 *   int8    H7  int8 vs fp32, graph for graph: encoder variants with the same
 *               fp32 decoder, decoder variants with the same fp32 encoder,
 *               WASM t=1/t=4 (browser) and native, interleaved over rounds
 *   quality H7/H2  mask quality of every variant against its fp32 reference
 *               on the scenario's prompts, on onnxruntime-web's WASM kernels
 *               (scripts/quality-check.mjs), plus refinement alignment
 *   e2e     H2  click-to-mask on a 100k x 80k DZI: crop read, encode, decode,
 *               cache hits on pan/zoom, refinement across a zoom (R1-R3),
 *               mask/polygon conversion (H3)
 *   responsiveness  H4  main-thread fps / long tasks during cold encodes in
 *               a worker vs on the main thread, with tiles settled, still
 *               loading, and while the user pans, per numThreads
 *   remote  H3  server-encode -> browser-decode and all-server topologies
 *
 * and writes results/<stamp>.json plus a summary table on stdout.
 *
 * Options:
 *   --suites native,models,int8,quality,e2e,responsiveness,remote   (default: all)
 *   --steps S1,S2                (e2e/remote scenario steps; default: all)
 *   --e2e-models mobile_sam      --e2e-threads 4   --main-threads 4   --no-main
 *   --webgpu-models edge_sam,mobile_sam   (SwiftShader cases are slow: keep this short)
 *   --native-threads 1,4
 *   --models mobile_sam,...      (default: every model whose files exist)
 *   --eps wasm,webgpu            (default: wasm,webgpu)
 *   --threads 1,4                (default: 1,4)
 *   --enc-reps 3 --dec-reps 20
 *   --int8-rounds 3 --int8-threads 1,4
 *   --e2e-drawer canvas|webgl   (OSD drawer for e2e/remote; default canvas)
 *   --resp-threads 1,2,3,4 --resp-reps 3 --resp-main-threads 4 --resp-drawers canvas,webgl
 *   --force-webgpu               run WebGPU cases even when the gate says no
 *   --chromium <path>            (default: $POC_CHROMIUM, /opt/pw-browsers/chromium,
 *                                 then Playwright's own)
 *   --headed                     run a visible browser (desktop Chrome reproduction)
 *   --port 5480
 *   --out <file>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { VIEW_W, scenarioSteps as allScenarioSteps } from './scenario.mjs';
import { MAX_LEVEL, SYNTH, levelDims, tileBytes } from './synth-tiles.mjs';
import { MODEL_TABLE, modelById, modelPaths } from './model-table.mjs';
import { runNativeCase } from './native-suite.mjs';
import { pickTargets } from './scene-targets.mjs';
import { printSummary } from './summary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const MODELS_DIR = path.join(APP, 'models');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} expects a value`);
  return v;
}
const flag = (f) => process.argv.includes(f);
const list = (f, fallback) =>
  String(arg(f, fallback))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const SUITES = list('--suites', 'native,models,int8,quality,e2e,responsiveness,remote');
const EPS = list('--eps', 'wasm,webgpu');
const THREADS = list('--threads', '1,4').map(Number);
const ENC_REPS = Number(arg('--enc-reps', '3'));
const DEC_REPS = Number(arg('--dec-reps', '20'));
const PORT = Number(arg('--port', '5480'));
const HEADED = flag('--headed');
const TIMEOUT_S = Number(arg('--timeout-s', '240'));

// One model list for the pages, the server and the runner: src/model-table.json.
const available = MODEL_TABLE.filter((m) => modelPaths(m, MODELS_DIR)).map((m) => m.id);
const NATIVE_THREADS = list('--native-threads', '1,4').map(Number);
const MODELS = list('--models', available.join(',')).filter((m) => {
  if (!available.includes(m)) {
    console.warn(`skip ${m}: model files missing (run fetch-models / export_models.py)`);
    return false;
  }
  return true;
});

function chromiumPath() {
  const explicit = arg('--chromium', process.env.POC_CHROMIUM);
  if (explicit) return explicit;
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    // The sandbox ships a directory; find its binary.
    const stat = fs.statSync('/opt/pw-browsers/chromium');
    if (stat.isFile()) return '/opt/pw-browsers/chromium';
    for (const c of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome']) {
      const p = path.join('/opt/pw-browsers/chromium', c);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // Playwright's bundled browser
}

const E2E_MODELS = list('--e2e-models', 'mobile_sam');
const WEBGPU_MODELS = list('--webgpu-models', 'edge_sam,mobile_sam');
const MAIN_THREADS = list('--main-threads', '4').map(Number);
const E2E_THREADS = list('--e2e-threads', '4').map(Number);
const STEP_FILTER = process.argv.includes('--steps') ? list('--steps', '') : null;
const FORCE_WEBGPU = flag('--force-webgpu');
const INT8_ROUNDS = Number(arg('--int8-rounds', '3'));
const INT8_THREADS = list('--int8-threads', '1,4').map(Number);
/** Encoder variants share the fp32 low-res decoder; decoder variants the fp32 encoder. */
const INT8_ENCODERS = [
  'mobile_sam',
  'mobile_sam_enc_int8',
  'mobile_sam_enc_int8mm',
  'mobile_sam_enc_qdq',
];
const INT8_DECODERS = [
  'mobile_sam',
  'mobile_sam_dec_int8',
  'mobile_sam_fulldec',
  'mobile_sam_int8',
];
const RESP_THREADS = list('--resp-threads', '1,2,3,4').map(Number);
/**
 * OSD drawer for the e2e and remote suites. Canvas by default: OSD 5's WebGL
 * drawer runs on SwiftShader in this GPU-less Chromium and saturates the main
 * thread and a core even with no inference (the responsiveness suite measures
 * both), which would inflate every latency here.
 */
const E2E_DRAWER = arg('--e2e-drawer', 'canvas');
const RESP_MAIN_THREADS = list('--resp-main-threads', '4').map(Number);
const RESP_REPS = Number(arg('--resp-reps', '3'));
const RESP_CONDITIONS = ['settled', 'loading', 'panning'];
/** OSD drawers to measure responsiveness with (see E2eInit.drawer). */
const RESP_DRAWERS = list('--resp-drawers', 'canvas,webgl');
/** Screen px per frame of the scripted pan (480 px/s at 60 fps). */
const PAN_PX = 8;
const scenarioSteps = () => allScenarioSteps(STEP_FILTER);

/**
 * Renders (and disk-caches) every synthetic tile the scenario can touch, so
 * the measured runs see a tile server that serves pre-rendered tiles — the
 * realistic case — rather than one rendering on demand.
 */
function prewarmTiles(steps) {
  const t0 = Date.now();
  let n = 0;
  for (const step of steps) {
    if (!step.view) continue;
    const { cx, cy, zoom } = step.view;
    // Viewport plus the encode margin plus a zoom-in step's worth of slack.
    const halfW = (VIEW_W / zoom) * 0.5 * 1.6;
    const halfH = (800 / zoom) * 0.5 * 1.6;
    const display = Math.min(MAX_LEVEL, MAX_LEVEL + Math.ceil(Math.log2(zoom)));
    for (let level = 8; level <= Math.min(MAX_LEVEL, display + 1); level++) {
      const { width, height, scale } = levelDims(level);
      const ts = SYNTH.tileSize;
      const x0 = Math.max(0, Math.floor(((cx - halfW) * scale) / ts));
      const x1 = Math.min(Math.ceil(width / ts) - 1, Math.floor(((cx + halfW) * scale) / ts));
      const y0 = Math.max(0, Math.floor(((cy - halfH) * scale) / ts));
      const y1 = Math.min(Math.ceil(height / ts) - 1, Math.floor(((cy + halfH) * scale) / ts));
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++, n++) tileBytes(level, tx, ty);
    }
  }
  console.log(`prewarmed ${n} synthetic tiles in ${Date.now() - t0} ms`);
}

/** Set in main() once the browser is up: total browser CPU seconds. */
let cpuTotal = async () => 0;

/**
 * Per-call CPU from the page's phase marks: ms of browser CPU per encode, and
 * per decode (the mean of the click and box+2pt prompts, which alternate).
 */
function cpuPerCall(marks, cfg, r) {
  const at = (l) => marks.find((m) => m.label === l)?.cpu;
  const span = (a, b) =>
    at(a) !== undefined && at(b) !== undefined ? (at(b) - at(a)) * 1000 : undefined;
  const enc = span('encode-start', 'encode-end');
  const dec = span('decode-start', 'decode-end');
  // A slow model may take fewer timed encodes than asked (bench-models.ts).
  const encReps = r?.encode?.n ?? cfg.encoderReps;
  return {
    encodeMs: enc !== undefined && encReps > 0 ? enc / encReps : undefined,
    decodeMs: dec !== undefined && cfg.decoderReps > 0 ? dec / (2 * cfg.decoderReps) : undefined,
  };
}

/** One H1 configuration on a fresh page (see src/bench-models.ts). */
async function runModelConfig(openPage, cfg) {
  const loadBefore = os.loadavg()[0];
  const { page, context, marks } = await openPage('/bench-models.html', { cpuMarks: true });
  await page
    .waitForFunction(() => typeof window.__runModelBench === 'function', null, {
      timeout: 60_000,
    })
    .catch(() => {});
  const t0 = Date.now();
  const timeoutMs = TIMEOUT_S * 1000;
  let r = await Promise.race([
    page
      .evaluate((c) => window.__runModelBench(c), cfg)
      .catch((e) => ({ config: cfg, error: `runner: ${e?.message ?? e}` })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ config: cfg, error: `timeout after ${TIMEOUT_S} s` }), timeoutMs),
    ),
  ]);
  if (r.error?.startsWith('timeout')) {
    const partial = await Promise.race([
      page.evaluate(() => window.__benchProgress ?? null).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    r = { ...r, partial };
  }
  await context.close();
  return {
    ...r,
    cpu: cpuPerCall(marks, cfg, r),
    loadavg: [loadBefore, os.loadavg()[0]],
    wallS: (Date.now() - t0) / 1000,
  };
}

function logModelResult(r, cfg, t0) {
  const tag = `${cfg.model.padEnd(22)} enc=${cfg.encoderEp.padEnd(6)} dec=${cfg.decoderEp.padEnd(6)} t=${cfg.threads}`;
  if (r.error) {
    console.log(
      `${tag}  ERROR ${r.error}${r.partial ? ` partial=${JSON.stringify(r.partial)}` : ''}`,
    );
    return;
  }
  const enc = r.encode.n
    ? `${r.encode.median.toFixed(0).padStart(6)} ms (n=${r.encode.n}, cpu ${fmt(r.cpu?.encodeMs)})`
    : `first ${r.firstEncode.toFixed(0)} ms`;
  console.log(
    `${tag}  encode ${enc}  decode(click) ${fmt(r.decodeClick.median, 1).padStart(7)} ms (cpu ${fmt(r.cpu?.decodeMs, 1)})  ` +
      `decode(box+2pt) ${fmt(r.decodeBoxPoints.median, 1).padStart(7)} ms  ` +
      `load ${(r.load.encoderLoad + r.load.decoderLoad).toFixed(0)} ms  load1 ${fmt(r.loadavg?.[0], 1)}  [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
  );
}

/**
 * H7: int8 against fp32 graph for graph, in the browser (WASM) and natively.
 * Rounds interleave every variant (the order rotates each round), so machine
 * load drifts hit all of them alike; each round is one fresh page per case.
 */
async function runInt8Suite(openPage, results) {
  const out = {
    rounds: INT8_ROUNDS,
    threads: INT8_THREADS,
    encoders: INT8_ENCODERS,
    decoders: INT8_DECODERS,
    sizes: {},
    browser: [],
    native: [],
  };
  results.int8 = out;
  for (const id of new Set([...INT8_ENCODERS, ...INT8_DECODERS])) {
    const files = modelPaths(modelById(id), MODELS_DIR);
    if (!files)
      throw new Error(`int8 suite: model files for ${id} missing (scripts/quantize_variants.py)`);
    out.sizes[id] = {
      encoderBytes: fs.statSync(files.encoder).size,
      decoderBytes: fs.statSync(files.decoder).size,
    };
  }
  const cases = [];
  for (const threads of INT8_THREADS) {
    for (const model of INT8_ENCODERS)
      cases.push({
        role: 'encoder',
        cfg: {
          model,
          encoderEp: 'wasm',
          decoderEp: 'wasm',
          threads,
          encoderReps: ENC_REPS,
          decoderReps: 0,
          decoderWarmups: 0,
        },
      });
    for (const model of INT8_DECODERS)
      cases.push({
        role: 'decoder',
        cfg: {
          model,
          encoderEp: 'wasm',
          decoderEp: 'wasm',
          threads,
          encoderReps: 0,
          decoderReps: DEC_REPS,
        },
      });
  }
  for (let round = 0; round < INT8_ROUNDS; round++) {
    console.log(`\n[int8 round ${round + 1}/${INT8_ROUNDS}]`);
    const shift = (round * 5) % cases.length;
    for (const c of [...cases.slice(shift), ...cases.slice(0, shift)]) {
      const t0 = Date.now();
      const r = await runModelConfig(openPage, c.cfg);
      out.browser.push({ role: c.role, round, ...r });
      save(results);
      logModelResult(r, c.cfg, t0);
    }
    for (const threads of INT8_THREADS) {
      for (const id of new Set([...INT8_ENCODERS, ...INT8_DECODERS])) {
        const spec = modelById(id);
        try {
          const r = await runNativeCase(
            spec,
            modelPaths(spec, MODELS_DIR),
            threads,
            ENC_REPS,
            DEC_REPS,
          );
          out.native.push({ round, ...r });
          console.log(
            `${id.padEnd(22)} native t=${threads}  encode ${r.encode.median.toFixed(0).padStart(6)} ms  decode(click) ${r.decodeClick.median.toFixed(1).padStart(6)} ms  load1 ${r.loadavg[0].toFixed(1)}`,
          );
        } catch (e) {
          out.native.push({
            round,
            config: { model: id, threads },
            error: String(e?.message ?? e),
          });
        }
        save(results);
      }
    }
  }
}

/** Distinct gland-zoom views (no shared tiles or embeddings), the same for every config. */
function responsivenessViews(n) {
  const zoom = VIEW_W / 10_000;
  const views = [];
  for (let i = 0; views.length < n; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    views.push({ cx: 12_000 + col * 17_000, cy: 9_000 + row * 12_000, zoom });
  }
  return views;
}

/**
 * H4 / review finding B2: main-thread responsiveness during cold encodes, per
 * numThreads, with OSD's tile loading controlled. Conditions per click:
 * - settled: the view's tiles finished loading before the click;
 * - loading: the click lands right after the view change, while OSD still
 *   fetches, decodes and draws tiles (what prepare-on-settle meets);
 * - panning: the user keeps panning (scripted, PAN_PX per frame) through the
 *   whole inference, so tiles keep loading.
 * Plus a pan with no inference (pan-only), the baseline of the same page.
 */
async function runResponsiveness(openPage, results) {
  results.responsiveness = [];
  const configs = RESP_DRAWERS.flatMap((drawer) => [
    ...RESP_THREADS.map((threads) => ({ mode: 'local', threads, drawer })),
    ...RESP_MAIN_THREADS.map((threads) => ({ mode: 'local-main', threads, drawer })),
  ]);
  const views = responsivenessViews(RESP_REPS * RESP_CONDITIONS.length);
  prewarmTiles(views.map((view) => ({ view })));
  const T = pickTargets();
  for (const c of configs) {
    const cfg = { mode: c.mode, model: E2E_MODELS[0], threads: c.threads, drawer: c.drawer };
    const { page, context } = await openPage('/e2e.html');
    await page.waitForFunction(() => typeof window.__e2e === 'object', null, { timeout: 60_000 });
    const init = await page.evaluate((x) => window.__e2e.init({ image: 'synth', ...x }), cfg);
    const run = { config: cfg, init, loadavg: [os.loadavg()[0]], samples: [] };
    results.responsiveness.push(run);
    console.log(`\n[responsiveness ${cfg.mode} t=${cfg.threads} drawer=${init.drawer}]`);
    // Baseline: the same pan with no inference running.
    for (let rep = 0; rep < RESP_REPS; rep++) {
      await page.evaluate((v) => window.__e2e.view(v), {
        cx: T.island.x,
        cy: T.island.y,
        zoom: VIEW_W / 10_000,
        settleTimeoutMs: 10_000,
      });
      await page.evaluate(() => window.__e2e.mark());
      const tiles0 = await page.evaluate(() => window.__e2e.tiles());
      await page.evaluate((px) => window.__e2e.startPan(px), PAN_PX);
      await new Promise((r) => setTimeout(r, 4000));
      const pan = await page.evaluate(() => window.__e2e.stopPan());
      const frames = await page.evaluate(() => window.__e2e.frameStats());
      const tiles1 = await page.evaluate(() => window.__e2e.tiles());
      const s = { cond: 'pan-only', rep, pan, frames, tilesLoaded: tiles1.loaded - tiles0.loaded };
      run.samples.push(s);
      console.log(
        `  pan-only  #${rep}  fps ${fmt(frames.fps)}  long tasks ${fmt(frames.longTaskMs)} ms  max gap ${fmt(frames.maxGap)} ms  tiles ${s.tilesLoaded}`,
      );
    }
    let k = 0;
    for (let rep = 0; rep < RESP_REPS; rep++) {
      for (const cond of RESP_CONDITIONS) {
        const view = views[k++];
        const rec = { cond, rep, view };
        try {
          rec.viewResult = await page.evaluate((v) => window.__e2e.view(v), {
            ...view,
            waitTiles: cond !== 'loading',
            settleTimeoutMs: 10_000,
          });
          rec.tilesAtClick = await page.evaluate(() => window.__e2e.tiles());
          const from = await page.evaluate(() => window.__e2e.mark());
          const s = await page.evaluate((p) => window.__e2e.toScreen(p), {
            x: view.cx,
            y: view.cy,
          });
          const cpu0 = await cpuTotal();
          await page.mouse.click(s.x, s.y);
          if (cond === 'panning') await page.evaluate((px) => window.__e2e.startPan(px), PAN_PX);
          const events = await page.evaluate(
            ([f, ms]) => window.__e2e.waitPainted(f, ms),
            [from, TIMEOUT_S * 1000],
          );
          if (cond === 'panning') rec.pan = await page.evaluate(() => window.__e2e.stopPan());
          rec.browserCpuMs = Math.round((await cpuTotal()) * 1000 - cpu0 * 1000);
          const tilesAfter = await page.evaluate(() => window.__e2e.tiles());
          rec.tilesLoadedDuring = tilesAfter.loaded - rec.tilesAtClick.loaded;
          const result = events.find((e) => e.type === 'result');
          rec.cached = result?.cached;
          rec.timings = result?.timings;
          rec.latency = events.find((e) => e.type === 'painted')?.latency;
          rec.frames = events.find((e) => e.type === 'frames');
          rec.error = events.find((e) => e.type === 'error')?.error;
        } catch (e) {
          rec.error = String(e?.message ?? e);
        }
        await page.evaluate(() => window.__e2e.cancel()).catch(() => {});
        run.samples.push(rec);
        save(results);
        const fr = rec.frames ?? {};
        console.log(
          `  ${cond.padEnd(8)}  #${rep}  ${rec.cached ? 'HIT ' : 'MISS'} click->painted ${fmt(rec.latency).padStart(5)} ms  enc ${fmt(rec.timings?.encode).padStart(5)}  ` +
            `fps ${fmt(fr.fps).padStart(3)}  long tasks ${fmt(fr.longTaskMs).padStart(5)} ms (longest ${fmt(fr.longestTaskMs)})  max gap ${fmt(fr.maxGap).padStart(5)} ms  ` +
            `tile jobs at click ${rec.tilesAtClick?.jobs ?? '-'}  tiles during ${rec.tilesLoadedDuring ?? '-'}${rec.pan ? `  pan ${rec.pan.frames} frames` : ''}${rec.error ? `  ERROR ${rec.error}` : ''}`,
        );
      }
    }
    run.loadavg.push(os.loadavg()[0]);
    await context.close();
  }
}

async function runScenario(openPage, cfg, steps) {
  const { page, context } = await openPage('/e2e.html');
  await page.waitForFunction(() => typeof window.__e2e === 'object', null, { timeout: 60_000 });
  const t0 = Date.now();
  const init = await page.evaluate((c) => window.__e2e.init({ image: 'synth', ...c }), cfg);
  const out = { config: cfg, init, initMs: Date.now() - t0, steps: [], loadavg: [os.loadavg()[0]] };
  console.log(`\n[e2e ${cfg.mode} ${cfg.model} t=${cfg.threads}] init ${out.initMs} ms`);
  // Points of the prompt being built (steps with `keep` add to it).
  let promptPoints = [];
  let refining = false;
  for (const step of steps) {
    const rec = { id: step.id, name: step.name };
    promptPoints.push(step.click);
    try {
      if (step.view) rec.view = await page.evaluate((v) => window.__e2e.view(v), step.view);
      if (step.prepare) rec.prepareMs = await page.evaluate(() => window.__e2e.prepare());
      const from = await page.evaluate(() => window.__e2e.mark());
      const s = await page.evaluate((p) => window.__e2e.toScreen(p), step.click);
      const cpu0 = await cpuTotal();
      const clickAt = Date.now();
      await page.mouse.click(s.x, s.y);
      rec.events = await page.evaluate(
        ([f, ms]) => window.__e2e.waitPainted(f, ms),
        [from, TIMEOUT_S * 1000],
      );
      rec.wallMs = Date.now() - clickAt;
      // Browser CPU (all processes) from click to painted; the remote modes'
      // server work runs in this Node process and is not included.
      rec.browserCpuMs = Math.round((await cpuTotal()) * 1000 - cpu0 * 1000);
      rec.analysis = await page.evaluate((gt) => window.__e2e.analyze(gt), step.gt);
      if (step.altGt) {
        const alt = await page.evaluate((gt) => window.__e2e.analyze(gt), step.altGt);
        rec.altGroundTruthIoU = alt.groundTruthIoU;
      }
      // A refinement step (after a `keep` step): the same object, so its best
      // mask must line up with the previous step's (IoU, centroid shift).
      if (refining)
        rec.vsPrevious = await page.evaluate(() => window.__e2e.compareWithRemembered());
      await page.evaluate(() => window.__e2e.remember());
      const result = rec.events?.find((e) => e.type === 'result');
      if (result) {
        // Did the decode see every point of the prompt (the encode covered them)?
        const r = result.view.region;
        rec.promptPoints = promptPoints.length;
        rec.promptInsideRegion = promptPoints.every(
          (p) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height,
        );
        if (step.expectCached !== undefined)
          rec.expectation = { cached: step.expectCached, ok: result.cached === step.expectCached };
      }
      if (!step.keep) rec.commitMask = await page.evaluate(() => window.__e2e.commit('mask'));
      rec.cache = await page.evaluate(() => window.__e2e.cacheStats());
      rec.memory = await page.evaluate(() => window.__e2e.memory());
    } catch (e) {
      rec.error = String(e?.message ?? e);
    }
    refining = Boolean(step.keep) && !rec.error;
    if (!step.keep || rec.error) {
      await page.evaluate(() => window.__e2e.cancel()).catch(() => {});
      promptPoints = [];
    }
    out.steps.push(rec);
    printStep(rec);
  }
  await context.close();
  out.loadavg.push(os.loadavg()[0]);
  return out;
}

function fmt(v, d = 0) {
  return typeof v === 'number' ? v.toFixed(d) : '-';
}

function printStep(rec) {
  if (rec.error) {
    console.log(`  ${rec.id} ERROR ${rec.error}`);
    return;
  }
  const r = rec.events?.find((e) => e.type === 'result');
  const p = rec.events?.find((e) => e.type === 'painted');
  const t = r?.timings ?? {};
  const a = rec.analysis ?? {};
  const commit = rec.commitMask?.events?.find((e) => e.type === 'commit');
  const fr = rec.events?.find((e) => e.type === 'frames');
  const cap = rec.commitMask?.events?.find((e) => e.type === 'capacity');
  console.log(
    `  ${rec.id} ${r?.cached ? 'HIT ' : 'MISS'} click->painted ${fmt(p?.latency).padStart(6)} ms | ` +
      `read ${fmt((t.readFetch ?? 0) + (t.readComposite ?? 0) + (t.readback ?? 0)).padStart(4)} (tiles ${fmt(t.tiles)}, L${fmt(t.level)}) ` +
      `pre ${fmt(t.preprocess).padStart(3)} enc ${fmt(t.encode ?? t.serverEncode).padStart(5)} dec ${fmt(t.decode, 1).padStart(5)}${t.maskInput ? ' +mask_input' : ''} ` +
      `rt ${fmt(t.roundTrip).padStart(4)}${t.wireBytes ? ` (${fmt(t.wireBytes / 1024)} KiB)` : ''} preview ${fmt(r?.previewBuild, 1)} | ` +
      `main-thread max frame gap ${fmt(fr?.maxGap)} ms | scale ${r ? r.view.scale.toFixed(4) : '-'} | ` +
      `GT IoU ${fmt(a.groundTruthIoU, 3)}${rec.altGroundTruthIoU !== undefined ? `/${fmt(rec.altGroundTruthIoU, 3)}` : ''} ` +
      `poly ${fmt(a.polygonVertices)}v ${fmt(a.polygonMs, 1)}ms IoU(poly,mask) ${fmt(a.polygonVsMaskIoU, 4)} | ` +
      `mask box ${fmt((a.maskBoxPixels ?? 0) / 1e6, 2)} Mpx ${fmt(a.maskMs, 1)}ms rle ${fmt(a.canonicalBytes)}B render ${fmt(a.renderBuildMs, 1)}ms | ` +
      `commit ${commit?.output ?? '-'}${cap ? ` (cap: ${fmt(cap.requested / 1e6)} Mpx)` : ''}` +
      (rec.promptPoints > 1
        ? ` | ${rec.promptPoints}-point prompt ${rec.promptInsideRegion ? 'inside' : 'OUTSIDE'} the encoded region`
        : '') +
      (rec.expectation
        ? ` | expected ${rec.expectation.cached ? 'HIT' : 'MISS'}: ${rec.expectation.ok ? 'ok' : 'FAILED'}`
        : '') +
      (rec.vsPrevious?.iou !== undefined
        ? ` | vs previous step: IoU ${fmt(rec.vsPrevious.iou, 3)}, centroid shift ${fmt(rec.vsPrevious.centroidShiftPx, 1)} px`
        : ''),
  );
}

async function main() {
  // No HMR and no file watching: an edit in the checkout must not reload a
  // page mid-measurement (it did once, and the destroyed context ended the run).
  const server = await createServer({
    configFile: path.join(APP, 'vite.config.mjs'),
    server: { port: PORT, strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  const base = `http://localhost:${PORT}`;
  const executablePath = chromiumPath();
  const browser = await chromium.launch({
    executablePath,
    headless: !HEADED,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
    ],
  });
  const results = {
    meta: {
      startedAt: new Date().toISOString(),
      host: {
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
        totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
        loadavg: os.loadavg(),
      },
      browser: {
        executablePath: executablePath ?? 'playwright-bundled',
        version: browser.version(),
      },
      args: process.argv.slice(2),
    },
    native: [],
    models: [],
    e2e: null,
    remote: null,
  };

  // CPU seconds summed over every browser process (renderer, its workers'
  // threads, and the GPU process where SwiftShader runs), 10 ms resolution.
  const cdp = await browser.newBrowserCDPSession();
  cpuTotal = async () => {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    return processInfo.reduce((s, p) => s + p.cpuTime, 0);
  };

  const openPage = async (url, { cpuMarks } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const marks = [];
    if (cpuMarks)
      await page.exposeFunction(
        '__cpuMark',
        async (label) => void marks.push({ label, cpu: await cpuTotal() }),
      );
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`  [page] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(`${base}${url}`);
    return { page, context, marks };
  };

  try {
    // The WebGPU gate (adapter checks, then a decoder microbenchmark on a
    // hardware adapter): recorded, and it decides whether WebGPU cases run.
    let webgpuAllowed = false;
    if (SUITES.includes('models') && EPS.includes('webgpu')) {
      const { page, context } = await openPage('/bench-models.html');
      await page.waitForFunction(() => typeof window.__webgpuGate === 'function', null, {
        timeout: 60_000,
      });
      results.webgpuGate = await page
        .evaluate(() => window.__webgpuGate())
        .catch((e) => ({ ep: 'wasm', reason: 'gate-error', error: String(e?.message ?? e) }));
      await context.close();
      webgpuAllowed = results.webgpuGate.ep === 'webgpu';
      console.log(`WebGPU gate: ${JSON.stringify(results.webgpuGate)}`);
      save(results);
    }
    // Per model: native cases, then the browser cases, back to back, so the
    // WASM/native ratio is taken under the same machine load.
    for (const model of SUITES.includes('native') || SUITES.includes('models') ? MODELS : []) {
      if (SUITES.includes('native')) {
        const spec = modelById(model);
        for (const threads of NATIVE_THREADS) {
          const tag = `${model.padEnd(18)} native         t=${threads}`;
          try {
            const r = await runNativeCase(
              spec,
              modelPaths(spec, MODELS_DIR),
              threads,
              ENC_REPS,
              DEC_REPS,
            );
            results.native.push(r);
            save(results);
            console.log(
              `${tag}  encode ${r.encode.median.toFixed(0).padStart(6)} ms (min ${r.encode.min.toFixed(0)})  ` +
                `decode(click) ${r.decodeClick.median.toFixed(1).padStart(7)} ms (min ${r.decodeClick.min.toFixed(1)})  ` +
                `decode(box+2pt) ${r.decodeBoxPoints.median.toFixed(1).padStart(7)} ms  load1 ${r.loadavg[0].toFixed(1)}`,
            );
          } catch (e) {
            results.native.push({ config: { model, threads }, error: String(e?.message ?? e) });
            console.log(`${tag}  ERROR ${e?.message ?? e}`);
          }
        }
      }
      if (!SUITES.includes('models')) continue;
      const configs = [];
      for (const threads of THREADS) {
        configs.push({
          model,
          encoderEp: 'wasm',
          decoderEp: 'wasm',
          threads,
          encoderReps: ENC_REPS,
          decoderReps: DEC_REPS,
        });
      }
      if (
        EPS.includes('webgpu') &&
        WEBGPU_MODELS.includes(model) &&
        (webgpuAllowed || FORCE_WEBGPU)
      ) {
        const t = THREADS[THREADS.length - 1];
        // SwiftShader WebGPU is CPU-emulated and 30-150x slower than WASM here:
        // one first call each, including pipeline compilation, reported as an
        // upper bound, not a GPU number. Only with --force-webgpu, since the
        // gate never picks such an adapter.
        configs.push({
          model,
          encoderEp: 'wasm',
          decoderEp: 'webgpu',
          threads: t,
          encoderReps: 0,
          decoderReps: 1,
          decoderWarmups: 1,
        });
        configs.push({
          model,
          encoderEp: 'webgpu',
          decoderEp: 'wasm',
          threads: t,
          encoderReps: 0,
          decoderReps: 0,
          decoderWarmups: 0,
        });
      }
      for (const cfg of configs) {
        const t0 = Date.now();
        const r = await runModelConfig(openPage, cfg);
        results.models.push(r);
        save(results);
        logModelResult(r, cfg, t0);
      }
    }

    if (SUITES.includes('int8')) await runInt8Suite(openPage, results);
    if (SUITES.includes('quality')) {
      // Node-side (onnxruntime-web WASM kernels), in a child process so its
      // CPU use does not overlap a browser case.
      const qFile = `${OUT}.quality.json`;
      const q = spawnSync(
        process.execPath,
        [path.join(HERE, 'quality-check.mjs'), '--out', qFile],
        {
          stdio: 'inherit',
        },
      );
      if (q.status === 0) {
        results.quality = JSON.parse(fs.readFileSync(qFile, 'utf8'));
        fs.rmSync(qFile, { force: true });
      } else {
        results.quality = { error: `quality-check exited ${q.status}` };
      }
      save(results);
    }

    if (SUITES.includes('e2e') || SUITES.includes('remote')) prewarmTiles(scenarioSteps());
    if (SUITES.includes('e2e')) {
      results.e2e = [];
      for (const model of E2E_MODELS) {
        for (const threads of E2E_THREADS) {
          results.e2e.push(
            await runScenario(
              openPage,
              { mode: 'local', model, threads, drawer: E2E_DRAWER },
              scenarioSteps(),
            ),
          );
          save(results);
        }
      }
      // The same inference on the main thread, to show what the worker buys
      // (the responsiveness suite measures this properly, per numThreads).
      if (!flag('--no-main')) {
        const mainSteps = scenarioSteps().filter((s) => ['S1', 'S2', 'S5'].includes(s.id));
        for (const threads of MAIN_THREADS) {
          results.e2e.push(
            await runScenario(
              openPage,
              { mode: 'local-main', model: E2E_MODELS[0], threads, drawer: E2E_DRAWER },
              mainSteps,
            ),
          );
          save(results);
        }
      }
    }
    if (SUITES.includes('responsiveness')) await runResponsiveness(openPage, results);
    if (SUITES.includes('remote')) {
      results.remote = [];
      const steps = scenarioSteps().filter((s) => ['S1', 'S2', 'S5', 'S7'].includes(s.id));
      for (const mode of ['remote-encoder', 'remote-all']) {
        results.remote.push(
          await runScenario(
            openPage,
            { mode, model: E2E_MODELS[0], threads: 4, drawer: E2E_DRAWER },
            steps,
          ),
        );
        save(results);
      }
      // float16 embeddings on the wire: does the mask change?
      results.f16check = [];
      for (const rec of results.remote[0].steps) {
        const r = rec.events?.find((e) => e.type === 'result');
        const step = steps.find((s) => s.id === rec.id);
        if (!r || !step) continue;
        const res = await fetch(`${base}/api/sam/f16check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            view: r.view,
            prompt: { points: [{ ...step.click, label: 1 }] },
            model: E2E_MODELS[0],
          }),
        });
        const j = await res.json();
        results.f16check.push({ id: rec.id, ...j });
        console.log(
          `  f16 check ${rec.id}: mask IoU f32 vs f16 per candidate ${j.perCandidate.map((c) => c.iou.toFixed(4)).join(', ')}; max |logit diff| ${Math.max(...j.perCandidate.map((c) => c.maxLogitDiff)).toFixed(3)}`,
        );
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  results.meta.finishedAt = new Date().toISOString();
  results.meta.loadavgEnd = os.loadavg();
  save(results);
  printSummary(results, MODEL_TABLE);
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
}

const OUT = arg(
  '--out',
  path.join(APP, 'results', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
);
/** Written after every case too, so an interrupted run keeps what it measured. */
function save(results) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
