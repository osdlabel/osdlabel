/**
 * The PoC's one-command benchmark.
 *
 *   pnpm --filter @osdlabel/poc-sam bench [-- options]
 *
 * Starts the harness's Vite server (COOP/COEP, models, synthetic gigapixel
 * DZI, remote-encode endpoints), drives headless Chromium through:
 *
 *   models  H1  encoder/decoder latency per model x EP x threads
 *   e2e     H2  click-to-mask on a 100k x 80k DZI: crop read, encode, decode,
 *               cache hits on pan/zoom, mask/polygon conversion (H3)
 *   remote  H3  server-encode -> browser-decode and all-server topologies
 *
 * and writes results/<stamp>.json plus a summary table on stdout.
 *
 * Options:
 *   --suites models,e2e,remote   (default: all)
 *   --models mobile_sam,...      (default: every model whose files exist)
 *   --eps wasm,webgpu            (default: wasm,webgpu)
 *   --threads 1,4                (default: 1,4)
 *   --enc-reps 3 --dec-reps 20
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
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickTargets } from './scene-targets.mjs';
import { MAX_LEVEL, SYNTH, levelDims, tileBytes } from './synth-tiles.mjs';

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

const SUITES = list('--suites', 'models,e2e,remote');
const EPS = list('--eps', 'wasm,webgpu');
const THREADS = list('--threads', '1,4').map(Number);
const ENC_REPS = Number(arg('--enc-reps', '3'));
const DEC_REPS = Number(arg('--dec-reps', '20'));
const PORT = Number(arg('--port', '5480'));
const HEADED = flag('--headed');
const TIMEOUT_S = Number(arg('--timeout-s', '240'));

// Must mirror src/model-specs.ts (kept in JS so the runner needs no build).
const MODEL_FILES = {
  mobile_sam: ['mobile_sam.encoder.onnx', 'sam_vit_h_4b8939.decoder.lowres.onnx'],
  mobile_sam_int8: ['mobile_sam.encoder.int8.onnx', 'sam_vit_h_4b8939.decoder.int8.onnx'],
  efficient_sam_ti: ['efficient_sam_vitt_encoder.onnx', 'efficient_sam_vitt_decoder.onnx'],
  edge_sam: ['edge_sam.encoder.rand.onnx', 'sam_vit_h_4b8939.decoder.lowres.onnx'],
  litemedsam: ['litemedsam.encoder.rand.onnx', 'sam_vit_h_4b8939.decoder.lowres.onnx'],
  sam2_tiny: ['sam2.1_hiera_tiny.encoder.rand.onnx', 'sam2.1_hiera_tiny.decoder.rand.onnx'],
  sam_vit_b: ['sam_vit_b.encoder.rand.onnx', 'sam_vit_h_4b8939.decoder.lowres.onnx'],
};
const LOWRES = 'sam_vit_h_4b8939.decoder.lowres.onnx';
const exists = (f) =>
  fs.existsSync(path.join(MODELS_DIR, f)) ||
  (f === LOWRES && fs.existsSync(path.join(MODELS_DIR, 'sam_vit_h_4b8939.decoder.onnx')));
const available = Object.keys(MODEL_FILES).filter((m) => MODEL_FILES[m].every(exists));
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
const E2E_THREADS = list('--e2e-threads', '4').map(Number);
const VIEW_W = 1280;

/** The H2/H3 scenario: zoom levels and pans a pathologist actually does. */
function scenarioSteps() {
  const T = pickTargets();
  const overview = VIEW_W / 40_000; // the whole island on screen
  const glandZoom = VIEW_W / 10_000;
  const glandGt = { kind: 'ellipse', x: T.gland.x, y: T.gland.y, rx: T.gland.rx, ry: T.gland.ry };
  const lumenGt = { ...glandGt, rx: T.gland.rx * 0.72, ry: T.gland.ry * 0.72 };
  const nucleusGt = { kind: 'ellipse', x: T.nucleus.x, y: T.nucleus.y, rx: T.nucleus.r, ry: T.nucleus.r };
  const g2 = T.gland2 ?? T.gland;
  return [
    { id: 'S1', name: 'overview, first click (cold encode): tissue island', view: { cx: T.island.x, cy: T.island.y, zoom: overview }, click: T.stroma, gt: { kind: 'none' } },
    { id: 'S2', name: 'same view, second object: gland (embedding cache hit)', click: { x: T.gland.x, y: T.gland.y }, gt: glandGt, altGt: lumenGt },
    { id: 'S3', name: 'pan 10% of viewport (inside margin): gland 2', view: { cx: T.island.x + 0.1 * 40_000, cy: T.island.y, zoom: overview }, click: { x: g2.x, y: g2.y }, gt: { kind: 'ellipse', x: g2.x, y: g2.y, rx: g2.rx, ry: g2.ry } },
    { id: 'S4', name: 'pan 70% (beyond margin): re-encode', view: { cx: T.island.x + 0.7 * 40_000, cy: T.island.y, zoom: overview }, click: { x: T.island.x + 0.7 * 40_000, y: T.island.y }, gt: { kind: 'none' } },
    { id: 'S5', name: 'zoom 4x onto the gland (too coarse: re-encode)', view: { cx: T.gland.x, cy: T.gland.y, zoom: glandZoom }, click: { x: T.gland.x, y: T.gland.y }, gt: glandGt, altGt: lumenGt },
    { id: 'S6', name: 'zoom 1.5x more (within maxZoomIn: reuse)', view: { cx: T.gland.x, cy: T.gland.y, zoom: glandZoom * 1.5 }, click: { x: T.gland.x + T.gland.rx * 0.86, y: T.gland.y }, gt: glandGt, altGt: lumenGt },
    { id: 'S7', name: 'zoom to 1:1 on a nucleus (crop capped at native resolution)', view: { cx: T.nucleus.x, cy: T.nucleus.y, zoom: 1 }, click: { x: T.nucleus.x, y: T.nucleus.y }, gt: nucleusGt },
    { id: 'S8', name: 'new view, prepare() on settle, then click (decode only)', view: { cx: g2.x, cy: g2.y, zoom: glandZoom }, prepare: true, click: { x: g2.x, y: g2.y }, gt: { kind: 'ellipse', x: g2.x, y: g2.y, rx: g2.rx, ry: g2.ry } },
  ];
}

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
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++, n++) tileBytes(level, tx, ty);
    }
  }
  console.log(`prewarmed ${n} synthetic tiles in ${Date.now() - t0} ms`);
}

async function runScenario(openPage, cfg, steps) {
  const { page, context } = await openPage('/e2e.html');
  await page.waitForFunction(() => typeof window.__e2e === 'object', null, { timeout: 60_000 });
  const t0 = Date.now();
  const init = await page.evaluate((c) => window.__e2e.init({ image: 'synth', ...c }), cfg);
  const out = { config: cfg, init, initMs: Date.now() - t0, steps: [] };
  console.log(`\n[e2e ${cfg.mode} ${cfg.model} t=${cfg.threads}] init ${out.initMs} ms`);
  for (const step of steps) {
    const rec = { id: step.id, name: step.name };
    try {
      if (step.view) rec.view = await page.evaluate((v) => window.__e2e.view(v), step.view);
      if (step.prepare) rec.prepareMs = await page.evaluate(() => window.__e2e.prepare());
      const from = await page.evaluate(() => window.__e2e.mark());
      const s = await page.evaluate((p) => window.__e2e.toScreen(p), step.click);
      const clickAt = Date.now();
      await page.mouse.click(s.x, s.y);
      rec.events = await page.evaluate(([f, ms]) => window.__e2e.waitPainted(f, ms), [from, TIMEOUT_S * 1000]);
      rec.wallMs = Date.now() - clickAt;
      rec.analysis = await page.evaluate((gt) => window.__e2e.analyze(gt), step.gt);
      if (step.altGt) {
        const alt = await page.evaluate((gt) => window.__e2e.analyze(gt), step.altGt);
        rec.altGroundTruthIoU = alt.groundTruthIoU;
      }
      rec.commitMask = await page.evaluate(() => window.__e2e.commit('mask'));
      rec.cache = await page.evaluate(() => window.__e2e.cacheStats());
      rec.memory = await page.evaluate(() => window.__e2e.memory());
    } catch (e) {
      rec.error = String(e?.message ?? e);
    }
    await page.evaluate(() => window.__e2e.cancel()).catch(() => {});
    out.steps.push(rec);
    printStep(rec);
  }
  await context.close();
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
      `pre ${fmt(t.preprocess).padStart(3)} enc ${fmt(t.encode ?? t.serverEncode).padStart(5)} dec ${fmt(t.decode, 1).padStart(5)} ` +
      `rt ${fmt(t.roundTrip).padStart(4)}${t.wireBytes ? ` (${fmt(t.wireBytes / 1024)} KiB)` : ''} preview ${fmt(r?.previewBuild, 1)} | ` +
      `main-thread max frame gap ${fmt(fr?.maxGap)} ms | scale ${r ? (r.view.scale).toFixed(4) : '-'} | ` +
      `GT IoU ${fmt(a.groundTruthIoU, 3)}${rec.altGroundTruthIoU !== undefined ? `/${fmt(rec.altGroundTruthIoU, 3)}` : ''} ` +
      `poly ${fmt(a.polygonVertices)}v ${fmt(a.polygonMs, 1)}ms IoU(poly,mask) ${fmt(a.polygonVsMaskIoU, 4)} | ` +
      `mask box ${fmt((a.maskBoxPixels ?? 0) / 1e6, 2)} Mpx ${fmt(a.maskMs, 1)}ms rle ${fmt(a.canonicalBytes)}B render ${fmt(a.renderBuildMs, 1)}ms | ` +
      `commit ${commit?.output ?? '-'}${cap ? ` (cap: ${fmt(cap.requested / 1e6)} Mpx)` : ''}`,
  );
}

async function main() {
  const server = await createServer({ configFile: path.join(APP, 'vite.config.mjs'), server: { port: PORT, strictPort: true } });
  await server.listen();
  const base = `http://localhost:${PORT}`;
  const executablePath = chromiumPath();
  const browser = await chromium.launch({
    executablePath,
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
  });
  const results = {
    meta: {
      startedAt: new Date().toISOString(),
      host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1), loadavg: os.loadavg() },
      browser: { executablePath: executablePath ?? 'playwright-bundled', version: browser.version() },
      args: process.argv.slice(2),
    },
    models: [],
    e2e: null,
    remote: null,
  };

  const openPage = async (url) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`  [page] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(`${base}${url}`);
    return { page, context };
  };

  try {
    if (SUITES.includes('models')) {
      const configs = [];
      for (const model of MODELS) {
        for (const threads of THREADS) {
          configs.push({ model, encoderEp: 'wasm', decoderEp: 'wasm', threads, encoderReps: ENC_REPS, decoderReps: DEC_REPS });
        }
        if (EPS.includes('webgpu')) {
          const t = THREADS[THREADS.length - 1];
          // SwiftShader WebGPU is CPU-emulated: decoder-only first (cheap), then
          // one encoder run under a timeout. Reported as bounds, not results.
          configs.push({ model, encoderEp: 'wasm', decoderEp: 'webgpu', threads: t, encoderReps: 0, decoderReps: Math.min(DEC_REPS, 5) });
          configs.push({ model, encoderEp: 'webgpu', decoderEp: 'wasm', threads: t, encoderReps: 1, decoderReps: 1 });
        }
      }
      for (const cfg of configs) {
        const { page, context } = await openPage('/bench-models.html');
        await page.waitForFunction(() => typeof window.__runModelBench === 'function', null, { timeout: 60_000 });
        const t0 = Date.now();
        const timeoutMs = TIMEOUT_S * 1000;
        let r = await Promise.race([
          page.evaluate((c) => window.__runModelBench(c), cfg),
          new Promise((resolve) => setTimeout(() => resolve({ config: cfg, error: `timeout after ${TIMEOUT_S} s` }), timeoutMs)),
        ]);
        if (r.error?.startsWith('timeout')) {
          const partial = await Promise.race([
            page.evaluate(() => window.__benchProgress ?? null),
            new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          r = { ...r, partial };
        }
        await context.close();
        results.models.push(r);
        const tag = `${cfg.model.padEnd(17)} enc=${cfg.encoderEp.padEnd(6)} dec=${cfg.decoderEp.padEnd(6)} t=${cfg.threads}`;
        if (r.error) {
          console.log(`${tag}  ERROR ${r.error}${r.partial ? ` partial=${JSON.stringify(r.partial)}` : ''}`);
        } else {
          const enc = r.encode.n ? `${r.encode.median.toFixed(0).padStart(6)} ms` : '     -   ';
          console.log(
            `${tag}  encode ${enc}  decode(click) ${r.decodeClick.median.toFixed(1).padStart(7)} ms  ` +
              `decode(box+2pt) ${r.decodeBoxPoints.median.toFixed(1).padStart(7)} ms  preprocess ${(r.preprocess.median || 0).toFixed(1)} ms  ` +
              `load ${(r.load.encoderLoad + r.load.decoderLoad).toFixed(0)} ms  [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
          );
        }
      }
    }

    if (SUITES.includes('e2e') || SUITES.includes('remote')) prewarmTiles(scenarioSteps());
    if (SUITES.includes('e2e')) {
      results.e2e = [];
      for (const model of E2E_MODELS) {
        for (const threads of E2E_THREADS) {
          results.e2e.push(await runScenario(openPage, { mode: 'local', model, threads }, scenarioSteps()));
        }
      }
      // The same inference on the main thread, to show what the worker buys.
      const mainSteps = scenarioSteps().filter((s) => ['S1', 'S2', 'S5'].includes(s.id));
      results.e2e.push(await runScenario(openPage, { mode: 'local-main', model: E2E_MODELS[0], threads: 4 }, mainSteps));
    }
    if (SUITES.includes('remote')) {
      results.remote = [];
      const steps = scenarioSteps().filter((s) => ['S1', 'S2', 'S5', 'S7'].includes(s.id));
      for (const mode of ['remote-encoder', 'remote-all']) {
        results.remote.push(await runScenario(openPage, { mode, model: E2E_MODELS[0], threads: 4 }, steps));
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
          body: JSON.stringify({ view: r.view, prompt: { points: [{ ...step.click, label: 1 }] }, model: E2E_MODELS[0] }),
        });
        const j = await res.json();
        results.f16check.push({ id: rec.id, ...j });
        console.log(`  f16 check ${rec.id}: mask IoU f32 vs f16 per candidate ${j.perCandidate.map((c) => c.iou.toFixed(4)).join(', ')}; max |logit diff| ${Math.max(...j.perCandidate.map((c) => c.maxLogitDiff)).toFixed(3)}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const out = arg('--out', path.join(APP, 'results', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
