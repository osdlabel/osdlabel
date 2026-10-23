/* global window, document -- used inside page.evaluate callbacks, which run in the browser */
/**
 * Pixel-pipeline PoC benchmark: one non-interactive command.
 *
 *   pnpm --filter @osdlabel/poc-pixel-pipeline bench [-- options]
 *
 * Builds the workspace packages it needs (turbo, cached), starts the harness
 * dev server (cross-origin isolated), drives headless Chromium through every
 * experiment, writes results/<timestamp>.json and prints a summary table.
 *
 * Options:
 *   --only h1,h2,h3,osd6,h4,devapp  subset of experiment groups (default: all)
 *   --quick                     fewer steps / shorter rAF windows (smoke run)
 *   --headed                    show the browser (real-GPU runs on a desktop)
 *   --chromium <path>           browser binary (default: $POC_CHROMIUM,
 *                               /opt/pw-browsers/chromium if present, else
 *                               Playwright's own)
 *   --channel chrome            use an installed Google Chrome instead
 *   --no-build                  skip the turbo build of dependencies
 *   --port <n>                  harness port (default 5400; dev app uses n+1)
 *   --out <file>                result path (default results/<timestamp>.json)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { runGridExperiments, runDevAppExperiment } from './grid.mjs';
import { printSummary } from './summary.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};

const GROUPS = ['h1', 'h2', 'h3', 'osd6', 'h4', 'devapp'];
const only = (opt('--only', GROUPS.join(',')) ?? '').split(',').filter(Boolean);
for (const g of only) if (!GROUPS.includes(g)) throw new Error(`unknown group ${g}`);
const quick = flag('--quick');
const port = Number(opt('--port', '5400'));
const outFile =
  opt('--out') ??
  path.join(APP_DIR, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

function resolveChromium() {
  const explicit = opt('--chromium') ?? process.env.POC_CHROMIUM;
  if (explicit) return { executablePath: explicit };
  if (opt('--channel')) return { channel: opt('--channel') };
  if (fs.existsSync('/opt/pw-browsers/chromium'))
    return { executablePath: '/opt/pw-browsers/chromium' };
  return {};
}

if (!flag('--no-build')) {
  console.log('building dependencies (turbo, cached)…');
  execFileSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', '--filter=@osdlabel/poc-pixel-pipeline^...'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const server = await createServer({
  configFile: path.join(APP_DIR, 'vite.config.mjs'),
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const base = `http://127.0.0.1:${port}`;

const launch = {
  headless: !flag('--headed'),
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-precise-memory-info',
    '--hide-scrollbars',
  ],
  ...resolveChromium(),
};
const browser = await chromium.launch(launch);

const results = {
  meta: {
    startedAt: new Date().toISOString(),
    quick,
    groups: only,
    host: {
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalMemGB: os.totalmem() / 2 ** 30,
      loadavg: os.loadavg(),
    },
    browser: { version: browser.version(), launch: { ...launch, args: launch.args } },
    gitHead: (() => {
      try {
        return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return null;
      }
    })(),
  },
};

async function harnessPage() {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 1100 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console]', m.text().slice(0, 300));
  });
  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, {
    timeout: 60000,
  });
  return { context, page };
}

const PRESETS = {
  brain: { center: 40, width: 80 },
  subdural: { center: 75, width: 200 },
  lung: { center: -600, width: 1500 },
  bone: { center: 300, width: 2000 },
  abdomen: { center: 50, width: 400 },
};

try {
  const pixel = await import(path.join(REPO_ROOT, 'packages', 'pixel', 'dist', 'index.js'));
  const { context, page } = await harnessPage();
  results.environment = await page.evaluate(() => window.__poc.environment());
  results.images = await page.evaluate(() => window.__poc.imageInfo());
  log('environment', JSON.stringify(results.environment));

  // ── H1 ─────────────────────────────────────────────────────────────
  if (only.includes('h1')) {
    log('H1 analytic');
    const ranges = { phantom: { min: -1000, max: 3000 }, ct12bit: { min: -1024, max: 3071 } };
    results.h1Analytic = {};
    for (const [rname, range] of Object.entries(ranges)) {
      results.h1Analytic[rname] = {};
      for (const [wname, w] of Object.entries(PRESETS)) {
        results.h1Analytic[rname][wname] = pixel.compareWindowPaths(w, range);
      }
    }
    // Projection modalities: a 12-bit CR/DX and a 16-bit mammogram, typical
    // soft-tissue (narrow) and overview (wide) windows in stored units.
    results.h1AnalyticProjection = {
      dx12bit: {
        narrow: pixel.compareWindowPaths({ center: 2048, width: 600 }, { min: 0, max: 4095 }),
        wide: pixel.compareWindowPaths({ center: 2048, width: 3000 }, { min: 0, max: 4095 }),
      },
      mammo16bit: {
        narrow: pixel.compareWindowPaths({ center: 30000, width: 4000 }, { min: 0, max: 65535 }),
        wide: pixel.compareWindowPaths({ center: 32768, width: 30000 }, { min: 0, max: 65535 }),
      },
    };
    log('H1 browser pixel check');
    const range = { min: -1000, max: 3000 };
    results.h1Browser = {};
    for (const [wname, w] of Object.entries(PRESETS)) {
      results.h1Browser[wname] = {};
      for (const p of ['gpu', 'cpu', 'css-osdlabel', 'css-unbounded']) {
        const setup = await page.evaluate(({ p, w }) => window.__poc.h1Setup(p, w), { p, w });
        const png = await page.locator('#h1').screenshot();
        const greys = await page.evaluate(
          (b64) => window.__poc.decodeRamp(b64),
          png.toString('base64'),
        );
        const stats = pixel.bandingStats(w, range, (v) => greys[v - range.min]);
        // Same input -> same output? Compare against the analytic model for this path.
        const model =
          p === 'gpu' || p === 'cpu'
            ? (v) => Math.round(pixel.applyVoi(v, w, 0, 255))
            : (v) =>
                pixel.cssBrightnessThenContrast8(
                  pixel.quantize8(v, range),
                  setup.brightness,
                  setup.contrast,
                );
        let modelMismatch = 0;
        let modelMaxDiff = 0;
        for (let v = range.min; v <= range.max; v++) {
          const d = Math.abs(greys[v - range.min] - model(v));
          if (d > 0) modelMismatch++;
          if (d > modelMaxDiff) modelMaxDiff = d;
        }
        results.h1Browser[wname][p] = { ...setup, stats, modelMismatch, modelMaxDiff };
      }
      log(
        `  ${wname}`,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(results.h1Browser[wname]).map(([k, v]) => [k, v.stats.distinctLevels]),
          ),
        ),
      );
    }
  }

  // ── H2 ─────────────────────────────────────────────────────────────
  if (only.includes('h2')) {
    results.h2 = { full: [], workers: [], osd: [] };
    for (const image of ['ct', 'mammo']) {
      for (const impl of ['lut32', 'lutBytes', 'direct']) {
        const steps = image === 'ct' ? (quick ? 20 : 120) : quick ? 4 : 20;
        log(`H2 full ${image} ${impl}`);
        results.h2.full.push(
          await page.evaluate(({ image, impl, steps }) => window.__poc.h2Full(image, impl, steps), {
            image,
            impl,
            steps,
          }),
        );
      }
    }
    for (const workers of [1, 2, 4]) {
      log(`H2 workers mammo x${workers}`);
      results.h2.workers.push(
        await page.evaluate(
          ({ workers, steps }) => window.__poc.h2Workers('mammo', workers, steps),
          { workers, steps: quick ? 4 : 20 },
        ),
      );
    }
    for (const image of ['ct', 'mammo']) {
      for (const zoom of ['fit', '1:1']) {
        for (const drawer of ['canvas', 'webgl-stock']) {
          log(`H2 osd ${image} ${zoom} ${drawer}`);
          results.h2.osd.push(
            await page.evaluate(
              ({ image, zoom, drawer, steps, rafMs }) =>
                window.__poc.h2Osd(image, zoom, drawer, steps, rafMs),
              { image, zoom, drawer, steps: quick ? 20 : 120, rafMs: quick ? 1000 : 3000 },
            ),
          );
        }
      }
    }
    // Where does the tiled CPU path break? Sweep the drawn area.
    results.h2.scaling = [];
    for (const viewSize of [512, 1024, 1536, 2048]) {
      log(`H2 scaling mammo 1:1 canvas ${viewSize}px`);
      results.h2.scaling.push(
        await page.evaluate(
          ({ viewSize, steps, rafMs }) =>
            window.__poc.h2Osd('mammo', '1:1', 'canvas', steps, rafMs, viewSize),
          { viewSize, steps: quick ? 20 : 60, rafMs: quick ? 1000 : 2000 },
        ),
      );
    }
  }

  // ── H3 ─────────────────────────────────────────────────────────────
  if (only.includes('h3')) {
    results.h3 = { upload: [], osd: [], equivalence: [], alignment: null };
    for (const tileSize of [256, 512]) {
      for (const format of ['rgba8', 'r16i', 'rg8', 'r32f', 'r16f']) {
        log(`H3 upload ${format} ${tileSize}`);
        results.h3.upload.push(
          await page.evaluate(
            ({ format, tileSize, count }) => window.__poc.h3Upload(format, tileSize, count),
            {
              format,
              tileSize,
              count: tileSize === 256 ? 64 : 32,
            },
          ),
        );
      }
    }
    const osdMatrix = [];
    for (const image of ['ct', 'mammo']) {
      for (const zoom of ['fit', '1:1']) {
        for (const format of ['r16i', 'r32f', 'rg8'])
          osdMatrix.push({ image, zoom, format, target: 'own' });
      }
    }
    osdMatrix.push({ image: 'mammo', zoom: '1:1', format: 'r16i', target: 'shared' });
    osdMatrix.push({ image: 'mammo', zoom: '1:1', format: 'r16f', target: 'own' });
    for (const c of osdMatrix) {
      log(`H3 osd ${c.image} ${c.zoom} ${c.format} ${c.target}`);
      results.h3.osd.push(
        await page.evaluate(
          ({ c, steps, rafMs }) =>
            window.__poc.h3Osd(c.image, c.zoom, c.format, c.target, steps, rafMs),
          { c, steps: quick ? 20 : 120, rafMs: quick ? 1000 : 3000 },
        ),
      );
    }
    results.h3.scaling = [];
    for (const viewSize of [512, 1024, 1536, 2048]) {
      log(`H3 scaling mammo 1:1 r16i ${viewSize}px`);
      results.h3.scaling.push(
        await page.evaluate(
          ({ viewSize, steps, rafMs }) =>
            window.__poc.h3Osd('mammo', '1:1', 'r16i', 'own', steps, rafMs, viewSize),
          { viewSize, steps: quick ? 20 : 60, rafMs: quick ? 1000 : 2000 },
        ),
      );
    }
    const eqCases = [
      { reference: 'webgl', rotation: 0, flip: false, smoothing: false, format: 'r16i' },
      { reference: 'webgl', rotation: 90, flip: true, smoothing: false, format: 'r16i' },
      { reference: 'webgl', rotation: 0, flip: false, smoothing: true, format: 'r16i' },
      { reference: 'webgl', rotation: 0, flip: false, smoothing: true, format: 'rg8' },
      { reference: 'webgl', rotation: 0, flip: false, smoothing: true, format: 'r32f' },
      { reference: 'canvas', rotation: 0, flip: false, smoothing: false, format: 'r16i' },
      { reference: 'canvas', rotation: 90, flip: true, smoothing: false, format: 'r16i' },
      { reference: 'canvas', rotation: 0, flip: false, smoothing: true, format: 'r16i' },
    ];
    for (const c of eqCases) {
      log(
        `H3 equivalence ct vs ${c.reference} rot=${c.rotation} flip=${c.flip} smooth=${c.smoothing} ${c.format}`,
      );
      results.h3.equivalence.push(
        await page.evaluate(
          (c) =>
            window.__poc.h3Equivalence(
              'ct',
              c.rotation,
              c.flip,
              c.smoothing,
              c.format,
              c.reference,
            ),
          c,
        ),
      );
    }
    log('H3 alignment with FabricOverlay');
    results.h3.alignment = await page.evaluate(() => window.__poc.h3Alignment());
    log('H3 tone seam: FabricOverlay.applyImageFilters -> VOI window');
    results.h3.toneSeam = await page.evaluate(() => window.__poc.h3ToneSeam());
  }
  await context.close();

  // ── OSD 6 probe ────────────────────────────────────────────────────
  if (only.includes('osd6')) {
    log('OSD 6.1.1 probe');
    const c6 = await browser.newContext({ viewport: { width: 1100, height: 600 } });
    const p6 = await c6.newPage();
    p6.on('pageerror', (e) => console.error('[osd6 pageerror]', e.message));
    await p6.goto(`${base}/osd6.html`);
    await p6.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, {
      timeout: 60000,
    });
    results.osd6 = await p6.evaluate(() => window.__osd6.run());
    log('  ', JSON.stringify(results.osd6));
    await c6.close();
  }

  // ── H4 ─────────────────────────────────────────────────────────────
  if (only.includes('h4')) {
    results.h4 = {};
    await runGridExperiments({ browser, base, quick, log, out: results.h4 });
  }
  if (only.includes('devapp')) {
    results.devApp = await runDevAppExperiment({
      browser,
      repoRoot: REPO_ROOT,
      port: port + 1,
      log,
    });
  }
} finally {
  results.meta.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

printSummary(results);
console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`);
