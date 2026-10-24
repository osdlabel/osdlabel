/**
 * One-command volume PoC benchmark.
 *
 *   pnpm --filter @osdlabel/poc-volume bench [-- --quick] [-- --only bench,mpr,niivue]
 *
 * Starts the PoC's Vite dev server (cross-origin isolated), drives headless
 * Chromium through bench.html (reslice + label maps), mpr.html (four osdlabel
 * cells: scrolling, rotation, cross-view annotation) and niivue.html (an
 * embedded Niivue 3D cell beside osdlabel cells), samples per-process memory
 * between steps, writes results/<timestamp>.json and prints a summary.
 *
 * Flags:
 *   --quick              small volume (256x256x200) and fewer reps
 *   --only <list>        subset of: bench,mpr,niivue,bundle
 *   --headed             run a visible browser (desktop reproduction)
 *   --chromium <path>    browser binary (default: $POC_CHROMIUM, then
 *                        /opt/pw-browsers/chromium if present, else
 *                        Playwright's own)
 *   --port <n>           first dev server port to try (default 5637)
 *   --out <file>         output path (default results/<timestamp>.json)
 *
 * The packages it imports must be built first (`pnpm exec turbo run build
 * --filter=@osdlabel/poc-volume^...`); `pnpm exec turbo run bench
 * --filter=@osdlabel/poc-volume` does that for you.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { findPidByMarker, sampleProcessMemory, MiB } from './proc-mem.mjs';
import { printSummary } from './summary.mjs';
import { crossViewCheck } from './cross-view-check.mjs';
import { bundleSizes } from './bundle-size.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};

const quick = flag('--quick');
const only = new Set(String(arg('--only', 'bench,mpr,niivue,bundle')).split(','));
const port = Number(arg('--port', '5637'));
const defaultChromium = fs.existsSync('/opt/pw-browsers/chromium')
  ? '/opt/pw-browsers/chromium'
  : undefined;
const executablePath = arg('--chromium', process.env.POC_CHROMIUM ?? defaultChromium);
const dims = quick ? { nx: 256, ny: 256, nz: 200 } : { nx: 512, ny: 512, nz: 400 };
const reps = quick ? 8 : 30;
const query = `?nx=${dims.nx}&ny=${dims.ny}&nz=${dims.nz}`;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.resolve(arg('--out', path.join(APP, 'results', `${stamp}.json`)));

function gitSha() {
  try {
    return execFileSync('git', ['-C', APP, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

const log = (...a) => console.log('[poc-volume]', ...a);

async function main() {
  // Other benchmarks may hold ports: take the first free one from --port up.
  let server = null;
  let usedPort = port;
  for (; usedPort < port + 40 && !server; usedPort++) {
    const s = await createServer({
      configFile: path.join(APP, 'vite.config.mjs'),
      server: { port: usedPort, strictPort: true, host: '127.0.0.1' },
    });
    try {
      await s.listen();
      server = s;
    } catch {
      await s.close();
    }
  }
  if (!server) throw new Error(`no free port in ${port}..${port + 39}`);
  const base = `http://localhost:${usedPort - 1}`;
  const browser = await chromium.launch({
    headless: !flag('--headed'),
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      // Unknown to Chromium (ignored); lets proc-mem find this browser's pid.
      `--poc-volume-run=${stamp}`,
    ],
  });
  const browserPid = findPidByMarker(`--poc-volume-run=${stamp}`);
  const mem = (label) => {
    const m = sampleProcessMemory(browserPid);
    if (!m) return { label, byType: null };
    const byType = Object.fromEntries(
      Object.entries(m).map(([k, v]) => [
        k,
        { count: v.count, rssMiB: MiB(v.rss), pssMiB: MiB(v.pss) },
      ]),
    );
    return { label, byType };
  };

  const result = {
    meta: {
      when: new Date().toISOString(),
      git: gitSha(),
      quick,
      dims,
      reps,
      chromium: browser.version(),
      executablePath: executablePath ?? 'playwright-default',
      headless: !flag('--headed'),
      host: {
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
        totalMemGiB: Math.round(os.totalmem() / 2 ** 30),
      },
      note: 'GPU timings are SwiftShader (CPU-emulated) unless meta.gpu says otherwise.',
    },
    memory: [],
  };

  const context = await browser.newContext({
    viewport: { width: 1100, height: 1100 },
    deviceScaleFactor: 1,
  });
  const open = async (page, file, extra = '') => {
    page.on('pageerror', (e) => log('pageerror', file, e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') log('console.error', file, m.text().slice(0, 300));
    });
    await page.goto(`${base}/${file}${query}${extra ? `&${extra}` : ''}`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, {
      timeout: 120000,
    });
  };
  const call = (page, fn, ...args) => page.evaluate(([f, a]) => window.__poc[f](...a), [fn, args]);

  try {
    if (only.has('bench')) {
      const page = await context.newPage();
      await open(page, 'bench.html');
      result.memory.push(mem('bench:start'));
      log('building volume', dims);
      result.build = await call(page, 'build');
      result.memory.push(mem('bench:volume-built'));
      log('cpu reslice');
      result.cpu = await call(page, 'cpu', reps);
      log('worker reslice');
      result.workers = await call(page, 'workers', quick ? [1, 2] : [1, 2, 4], reps);
      result.gl = {};
      for (const fmt of ['r16i', 'r16f', 'r32f']) {
        log('webgl2', fmt);
        result.gl[fmt] = await call(page, 'gl', fmt, reps);
        result.memory.push(mem(`bench:gl-${fmt}-uploaded`));
        await call(page, 'glDispose');
        await page.waitForTimeout(500);
        result.memory.push(mem(`bench:gl-${fmt}-disposed`));
      }
      log('label maps');
      result.labels = await call(page, 'labels', quick ? 10 : 20, 15, quick ? 3 : 5);
      result.memory.push(mem('bench:labels'));
      result.benchContexts = await call(page, 'contexts');
      await page.close();
    }
    if (only.has('mpr')) {
      result.mpr = [];
      const frames = quick ? 30 : 120;
      for (const drawer of ['canvas', 'webgl']) {
        const page = await context.newPage();
        log('mpr', drawer);
        await open(page, `mpr.html`, `drawer=${drawer}`);
        const setup = await call(page, 'setup');
        result.memory.push(mem(`mpr-${drawer}:setup`));
        const loops = [];
        const plan = [
          ['pan-zoom-axial', 'cpu'],
          ['scroll-axial', 'cpu'],
          ['scroll-coronal', 'cpu'],
          ['rotate-oblique', 'cpu'],
          ['rotate-oblique', 'workers'],
          ['scroll-axial', 'workers'],
          ['rotate-oblique', 'gl'],
          ['scroll-axial', 'gl'],
        ];
        for (const [scenario, method] of plan) {
          log(' loop', scenario, method);
          loops.push(await call(page, 'loop', scenario, method, frames));
        }
        result.memory.push(mem(`mpr-${drawer}:after-loops`));
        const crossView = await crossViewCheck(page, call, dims);
        if (drawer === 'canvas') {
          await page.screenshot({ path: path.join(path.dirname(outFile), `mpr-${stamp}.png`) });
        }
        result.mpr.push({
          drawer,
          setup,
          loops,
          crossView,
          contexts: await call(page, 'contexts'),
        });
        await page.close();
      }
    }
    if (only.has('niivue')) {
      const page = await context.newPage();
      log('niivue');
      await open(page, 'niivue.html');
      result.memory.push(mem('niivue:start'));
      const setup = await call(page, 'setup');
      result.memory.push(mem('niivue:setup'));
      log(' rotate');
      const rotate = await call(page, 'rotate', quick ? 30 : 120);
      log(' shared labels');
      const labels = await call(page, 'sharedLabels');
      result.memory.push(mem('niivue:labels'));
      const accuracy = await call(page, 'overlayAccuracy');
      await page.screenshot({ path: path.join(path.dirname(outFile), `niivue-${stamp}.png`) });
      result.niivue = { setup, rotate, labels, accuracy, contexts: await call(page, 'contexts') };
      await page.close();
    }
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }

  if (only.has('bundle')) {
    log('bundle sizes');
    result.bundle = await bundleSizes(APP);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  log('wrote', path.relative(process.cwd(), outFile));
  printSummary(result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
