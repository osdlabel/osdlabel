/* global window -- page.evaluate callbacks run in the browser */
/**
 * Frame-axis PoC benchmark: one non-interactive command.
 *
 *   pnpm --filter @osdlabel/poc-frame-axis bench [-- options]
 *
 * Starts the harness's Vite server, launches Chromium (headless by default),
 * runs the matrix, writes results/<timestamp>/results.json (and
 * results/latest.json), and prints summary tables.
 *
 * Options:
 *   --groups env,model,strategies,layers,cine,solid   which parts to run (default: all)
 *   --quick                 fewer steps / shorter scrolls (smoke run)
 *   --chromium <path>       browser binary (default: $BENCH_CHROMIUM, else
 *                           /opt/pw-browsers/chromium if present, else Playwright's own)
 *   --headed                run a visible window — use this on a desktop with a
 *                           real GPU to reproduce on real hardware
 *   --channel chrome        use the installed Google Chrome instead of a binary path
 *   --port <n>              harness server port (default 5531)
 *   --out <dir>             results directory (default results/<timestamp>)
 *   --only <regex>          run only the configurations whose name matches
 *   --reps <n>              repetitions per Solid configuration (default 5; --quick 1)
 *
 * Memory is the PSS of every process in the browser's tree (Linux /proc only;
 * reported as null elsewhere), sampled before setup, after setup and after the
 * runs of each configuration, so deltas include the GPU process (SwiftShader
 * textures live there in this sandbox).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { aggregateSolid, fmtSpread } from './solid-aggregate.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const QUICK = flag('--quick');
const GROUPS = (opt('--groups', 'env,model,strategies,layers,cine,solid') ?? '').split(',');
const PORT = Number(opt('--port', '5531'));
const OUT = path.resolve(
  opt('--out', path.join(APP, 'results', new Date().toISOString().replace(/[:.]/g, '-'))),
);
const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium';
const CHROMIUM =
  opt('--chromium') ??
  process.env.BENCH_CHROMIUM ??
  (fs.existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined);
const CHANNEL = opt('--channel');
const HEADED = flag('--headed');
const ONLY = opt('--only') ? new RegExp(opt('--only')) : undefined;

// ── memory (Linux /proc) ──────────────────────────────────────────────────
function childrenOf(pid) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const parent = new Map();
  for (const d of entries) {
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parent.set(Number(d), ppid);
    } catch {
      /* exited */
    }
  }
  const tree = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, pp] of parent) {
      if (!tree.has(p) && tree.has(pp)) {
        tree.add(p);
        grew = true;
      }
    }
  }
  for (const p of tree) out.push(p);
  return out;
}

function pssMB(pid) {
  if (!pid || process.platform !== 'linux') return null;
  const byType = {};
  let total = 0;
  for (const p of childrenOf(pid)) {
    try {
      const rollup = fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8');
      const kb = Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
      const cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8');
      const type = /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'browser';
      byType[type] = (byType[type] ?? 0) + kb / 1024;
      total += kb / 1024;
    } catch {
      /* exited */
    }
  }
  return {
    total: Math.round(total),
    ...Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v)])),
  };
}

const delta = (a, b) => (a && b ? Math.round(b.total - a.total) : null);

// ── harness plumbing ──────────────────────────────────────────────────────
async function startServer() {
  const server = await createServer({
    configFile: path.join(APP, 'vite.config.mjs'),
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  return server;
}

async function launch() {
  const launchOpts = {
    headless: !HEADED,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--enable-precise-memory-info',
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  };
  if (CHANNEL) launchOpts.channel = CHANNEL;
  else if (CHROMIUM) launchOpts.executablePath = CHROMIUM;
  const server = await chromium.launchServer(launchOpts);
  const browser = await chromium.connect(server.wsEndpoint());
  return { server, browser, pid: server.process()?.pid };
}

async function openPage(browser, page = 'index.html') {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const p = await context.newPage();
  p.on('pageerror', (e) => console.error('  pageerror:', e.message));
  await p.goto(`http://127.0.0.1:${PORT}/${page}`, { waitUntil: 'load' });
  await p.waitForFunction('window.__poc && window.__poc.ready === true', null, { timeout: 120000 });
  return { context, page: p };
}

const call = (page, fn, arg) => page.evaluate(([f, a]) => window.__poc[f](a), [fn, arg]);

// ── matrix ────────────────────────────────────────────────────────────────
const CT = { data: 'ct', frames: 300, width: 512, height: 512, pixels: 'gray8' };
const LAT_STEPS = QUICK ? 10 : 40;
const SCROLL_MS = QUICK ? 1200 : 3000;

const load = () => os.loadavg().map((x) => Math.round(x * 100) / 100);

async function runConfig(browser, pid, name, setupOpts, runs) {
  const { context, page } = await openPage(browser);
  const mem0 = pssMB(pid);
  const result = { name, setupOpts, loadAvgBefore: load() };
  try {
    result.setup = await call(page, 'setup', setupOpts);
    const mem1 = pssMB(pid);
    for (const [label, fn, arg] of runs) {
      result[label] = await call(page, fn, arg);
    }
    const mem2 = pssMB(pid);
    result.memory = {
      before: mem0,
      afterSetup: mem1,
      afterRuns: mem2,
      setupDeltaMB: delta(mem0, mem1),
      runDeltaMB: delta(mem1, mem2),
    };
    result.loadAvgAfter = load();
    await call(page, 'teardown');
  } catch (err) {
    result.error = String(err?.message ?? err);
    console.error(`  ${name}: ${result.error}`);
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

const STRATEGY_RUNS = () => [
  ['latency', 'latency', { steps: LAT_STEPS }],
  ['scroll60', 'scroll', { rate: 60, durationMs: SCROLL_MS, policy: 'latest' }],
  ['scroll60d', 'scroll', { rate: 60, durationMs: SCROLL_MS, policy: 'await-drawn' }],
  ['verify', 'verify', { steps: QUICK ? 5 : 15 }],
  // Redraw without changing the frame: the drawer's per-draw cost alone, so
  // the frame swap's own cost (upload) is the difference.
  ['redraw', 'redraw', { count: QUICK ? 10 : 30 }],
];

async function groupStrategies(browser, pid) {
  const out = [];
  const strategies = ['mutable', 'reset', 'open', 'open-png', 'opacity'];
  for (const drawer of ['webgl', 'canvas']) {
    for (const strategy of drawer === 'webgl' ? [...strategies, 'mutable-noinval'] : strategies) {
      const name = `${strategy}/${drawer}`;
      if (ONLY && !ONLY.test(name)) continue;
      process.stdout.write(`  strategies ${name} ... `);
      const t = Date.now();
      const r = await runConfig(
        browser,
        pid,
        name,
        {
          ...CT,
          strategy,
          drawer,
          annotationsPerFrame: 0,
          layer: 'cache',
          decorations: false,
          silenceMultiImageWarnings: strategy === 'opacity',
        },
        STRATEGY_RUNS(),
      );
      console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
      out.push(r);
    }
  }
  // The pixel path: pre-decoded ImageBitmaps instead of gray8 + LUT.
  for (const drawer of ['webgl', 'canvas']) {
    const name = `mutable-bitmap/${drawer}`;
    if (ONLY && !ONLY.test(name)) continue;
    process.stdout.write(`  strategies ${name} ... `);
    const t = Date.now();
    out.push(
      await runConfig(
        browser,
        pid,
        name,
        {
          ...CT,
          pixels: 'bitmap',
          strategy: 'mutable',
          drawer,
          annotationsPerFrame: 0,
          layer: 'cache',
          decorations: false,
        },
        STRATEGY_RUNS(),
      ),
    );
    console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  return out;
}

async function groupLayers(browser, pid) {
  const out = [];
  const drawers = (opt('--layer-drawers', 'canvas,webgl') ?? '').split(',');
  // `cache-nocache` = the per-frame object cache with Fabric's per-object
  // render caching switched off (simple shapes redraw faster than they blit).
  const allLayers = ['cache', 'cache-nocache', 'rebuild-sync', 'rebuild-async', 'visibility'];
  const counts = QUICK ? [0, 50] : [0, 10, 50, 200];
  for (const drawer of drawers) {
    // The full matrix on the canvas drawer; on WebGL (CPU-emulated here) only
    // the recommended layer, to show the drawer's share.
    const layers = drawer === 'canvas' ? allLayers : ['cache-nocache'];
    for (const layerName of layers) {
      for (const n of counts) {
        if (n === 0 && layerName !== 'cache') continue;
        if (drawer !== 'canvas' && n === 200) continue;
        const layer = layerName === 'cache-nocache' ? 'cache' : layerName;
        const objectCaching = layerName !== 'cache-nocache';
        const name = `${layerName}/${n}/${drawer}`;
        if (ONLY && !ONLY.test(name)) continue;
        process.stdout.write(`  layers ${name} ... `);
        const t = Date.now();
        out.push(
          await runConfig(
            browser,
            pid,
            name,
            {
              ...CT,
              strategy: 'mutable',
              drawer,
              annotationsPerFrame: n,
              layer,
              objectCaching,
              decorations: true,
            },
            [
              ['latency', 'latency', { steps: QUICK ? 10 : 30 }],
              ['scroll60', 'scroll', { rate: 60, durationMs: SCROLL_MS }],
            ],
          ),
        );
        console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
      }
    }
  }
  return out;
}

async function groupCine(browser, pid) {
  const out = [];
  const variants = QUICK
    ? [{ source: 'rgba', drawer: 'canvas', fps: 30 }]
    : [
        { source: 'rgba', drawer: 'canvas', fps: 30 },
        { source: 'rgba', drawer: 'canvas', fps: 60 },
        { source: 'rgba', drawer: 'webgl', fps: 30 },
        { source: 'rgba', drawer: 'webgl', fps: 60 },
        { source: 'bitmap', drawer: 'canvas', fps: 30 },
        { source: 'bitmap', drawer: 'canvas', fps: 60 },
        { source: 'webcodecs', drawer: 'canvas', fps: 30 },
        { source: 'webcodecs', drawer: 'canvas', fps: 60 },
        { source: 'video', drawer: 'canvas', fps: 30, videoTimes: 'nominal' },
        { source: 'video', drawer: 'canvas', fps: 30, videoTimes: 'calibrated' },
        { source: 'video', drawer: 'canvas', fps: 60, videoTimes: 'nominal' },
        { source: 'video', drawer: 'canvas', fps: 60, videoTimes: 'calibrated' },
      ];
  for (const v of variants) {
    const name = `cine/${v.source}${v.videoTimes ? `-${v.videoTimes}` : ''}/${v.drawer}/${v.fps}`;
    if (ONLY && !ONLY.test(name)) continue;
    process.stdout.write(`  ${name} ... `);
    const t = Date.now();
    const { context, page } = await openPage(browser);
    const mem0 = pssMB(pid);
    const r = { name, opts: v, loadAvgBefore: load() };
    try {
      r.result = await call(page, 'cine', {
        ...v,
        frames: 100,
        width: 800,
        height: 600,
        annotationsPerFrame: 3,
        decorations: true,
        loops: QUICK ? 1 : 3,
      });
      r.memory = { before: mem0, after: pssMB(pid), deltaMB: delta(mem0, pssMB(pid)) };
    } catch (err) {
      r.error = String(err?.message ?? err);
      console.error(`  ${name}: ${r.error}`);
    } finally {
      await context.close().catch(() => {});
    }
    console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
    out.push(r);
  }
  return out;
}

async function groupModel(browser) {
  // H1 model costs (pure JS in the page): frame-axis vs one ImageId per slice.
  const out = [];
  const sizes = QUICK ? [10] : [10, 50];
  for (const perFrame of sizes) {
    const name = `model/300x${perFrame}`;
    if (ONLY && !ONLY.test(name)) continue;
    process.stdout.write(`  ${name} ... `);
    const t = Date.now();
    const { context, page } = await openPage(browser);
    try {
      out.push({
        name,
        loadAvgBefore: load(),
        result: await call(page, 'model', { frames: 300, perFrame, reps: QUICK ? 5 : 15 }),
      });
    } catch (err) {
      out.push({ name, error: String(err?.message ?? err) });
      console.error(`  ${name}: ${String(err?.message ?? err)}`);
    } finally {
      await context.close().catch(() => {});
    }
    console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  return out;
}

/** VectorObjectCache's default bound (osdlabel), for sizing the window pass. */
const VECTOR_CACHE_BOUND = 5000;
const SOLID_REPS = Number(opt('--reps', QUICK ? '1' : '5'));

/**
 * The Solid binding, through its public options only. Every configuration
 * runs SOLID_REPS times, each in a fresh page, with three recorded passes of
 * a scripted 60 Hz wheel:
 * - cold: frames 0..~180, all first visits;
 * - revisit: the same frames again. With object reuse on, at 50+ per slice
 *   this overruns the reuse cache's 5,000-object bound, so it is not "warm";
 * - window: bouncing within the first W frames, W sized so W x perSlice fits
 *   the bound (all 180 at 10 per slice), after an unrecorded priming pass:
 *   object reuse at its best case.
 */
async function groupSolid(browser, pid) {
  const out = [];
  const base = { frames: 300, width: 512, height: 512 };
  const rebuild = { reuseObjects: false };
  const reuse = { reuseObjects: true };
  const variants = QUICK
    ? [
        {
          name: 'solid/frame-axis/rebuild/10',
          ...base,
          annotationsPerFrame: 10,
          frameCellOptions: rebuild,
        },
        {
          name: 'solid/frame-axis/reuse/10',
          ...base,
          annotationsPerFrame: 10,
          frameCellOptions: reuse,
        },
        {
          name: 'solid/slice-ids/default/10',
          ...base,
          model: 'slice-ids',
          annotationsPerFrame: 10,
        },
      ]
    : [
        // The binding's defaults with nothing to annotate: the pixel path alone.
        { name: 'solid/frame-axis/default/0', ...base, annotationsPerFrame: 0, reps: 3 },
        ...[10, 50, 200].flatMap((n) => [
          // Object reuse off (the default) vs on, both with the binding's
          // default drawer (canvas) and Fabric object caching (off).
          {
            name: `solid/frame-axis/rebuild/${n}`,
            ...base,
            annotationsPerFrame: n,
            frameCellOptions: rebuild,
          },
          {
            name: `solid/frame-axis/reuse/${n}`,
            ...base,
            annotationsPerFrame: n,
            frameCellOptions: reuse,
          },
          // The alternative model on equal footing: same presenter, same
          // options (the binding's defaults), annotations keyed by slice id.
          {
            name: `solid/slice-ids/default/${n}`,
            ...base,
            model: 'slice-ids',
            annotationsPerFrame: n,
          },
        ]),
        // A per-slice limit makes the constraint memo recount on every step.
        {
          name: 'solid/frame-axis/default/50/limit',
          ...base,
          annotationsPerFrame: 50,
          perSliceLimit: true,
        },
        {
          name: 'solid/slice-ids/default/50/limit',
          ...base,
          model: 'slice-ids',
          annotationsPerFrame: 50,
          perSliceLimit: true,
        },
        // Fabric's own default (object caching on), for the record.
        {
          name: 'solid/frame-axis/objcache/50',
          ...base,
          annotationsPerFrame: 50,
          frameCellOptions: { objectCaching: true },
          reps: 3,
        },
        // WebGL opted in (SwiftShader here: CPU-emulated, pessimistic).
        {
          name: 'solid/frame-axis/webgl/10',
          ...base,
          annotationsPerFrame: 10,
          frameCellOptions: { drawer: 'webgl' },
          reps: 3,
        },
        // Today's per-assignment path for N plain images (not a model): reference only.
        {
          name: 'solid/reopen-per-slice/10',
          ...base,
          model: 'reopen-per-slice',
          annotationsPerFrame: 10,
          reps: 1,
        },
      ];
  for (const v of variants) {
    if (ONLY && !ONLY.test(v.name)) continue;
    const reps = Math.min(v.reps ?? SOLID_REPS, SOLID_REPS);
    const { name, ...rest } = v;
    const setupOpts = { ...rest };
    delete setupOpts.reps;
    const perSlice = setupOpts.annotationsPerFrame;
    const window = perSlice > 0 ? Math.min(180, Math.floor(VECTOR_CACHE_BOUND / perSlice)) : 180;
    for (let rep = 0; rep < reps; rep++) {
      process.stdout.write(`  ${name} #${rep + 1}/${reps} ... `);
      const t = Date.now();
      const { context, page } = await openPage(browser, 'solid.html');
      const mem0 = pssMB(pid);
      const r = { name, rep, opts: setupOpts, loadAvgBefore: load() };
      try {
        r.setup = await call(page, 'setup', setupOpts);
        // A non-default view (rotated, zoomed): does navigation keep it?
        r.viewBefore = await call(page, 'prepareView');
        r.passes = {};
        r.passes.cold = await call(page, 'scroll', { rate: 60, durationMs: SCROLL_MS });
        r.passes.revisit = await call(page, 'scroll', { rate: 60, durationMs: SCROLL_MS });
        await call(page, 'scroll', {
          rate: 60,
          durationMs: Math.ceil((window / 60) * 1000) + 300,
          window,
          record: false,
        });
        r.passes.window = await call(page, 'scroll', { rate: 60, durationMs: SCROLL_MS, window });
        r.viewAfter = await call(page, 'viewState');
        if (perSlice > 0 && setupOpts.model !== 'reopen-per-slice') {
          r.edit = await call(page, 'editProbe', QUICK ? 5 : 11);
        }
        if (rep === 0) {
          // Real input: Playwright mouse.wheel over the cell (the browser's own
          // wheel pipeline). Its rate is bounded by the CDP round trip, not by us.
          await page.mouse.move(400, 400);
          const wheelMs = QUICK ? 1000 : 2000;
          await call(page, 'startRecording');
          const t0 = Date.now();
          let n = 0;
          while (Date.now() - t0 < wheelMs) {
            await page.mouse.wheel(0, 100);
            n++;
            await new Promise((res) => setTimeout(res, 16));
          }
          r.realWheel = { ...(await call(page, 'stopRecording')), wheelEventsSent: n };
        }
        r.memory = { before: mem0, after: pssMB(pid), deltaMB: delta(mem0, pssMB(pid)) };
        r.loadAvgAfter = load();
      } catch (err) {
        r.error = String(err?.message ?? err);
        console.error(`  ${name}: ${r.error}`);
      } finally {
        await context.close().catch(() => {});
      }
      console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
      out.push(r);
    }
  }
  return out;
}

// ── summary tables ────────────────────────────────────────────────────────
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? '-' : Number(x).toFixed(1));
function table(rows, cols) {
  const widths = cols.map(([h, fn]) =>
    Math.max(h.length, ...rows.map((r) => String(fn(r)).length)),
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols.map(([h]) => h)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map(([, fn]) => fn(r))));
}

function summary(results) {
  if (results.env) {
    console.log('\nEnvironment');
    console.log(JSON.stringify(results.env, null, 2));
  }
  if (results.model) {
    console.log(
      '\nH1 — model costs (median ms unless noted): frame axis vs one ImageId per slice.',
    );
    table(results.model, [
      ['config', (r) => r.name],
      ['index ms', (r) => r.result?.indexMs ?? '-'],
      ['step idx us', (r) => r.result?.stepUs?.frameAxisIndexed ?? '-'],
      ['step naive us', (r) => r.result?.stepUs?.frameAxisNaiveFilter ?? '-'],
      ['step slice us', (r) => r.result?.stepUs?.perSlice ?? '-'],
      ['cstr frame', (r) => r.result?.constraints?.perSliceLimit?.frameAxisPerFrameMs ?? '-'],
      ['cstr slice', (r) => r.result?.constraints?.perSliceLimit?.perSlicePerImageMs ?? '-'],
      ['cstr series(fa)', (r) => r.result?.constraints?.perSeriesLimit?.frameAxisPerImageMs ?? '-'],
      [
        'cstr series(ps)',
        (r) => r.result?.constraints?.perSeriesLimit?.perSliceGlobalOverSeriesMs ?? '-',
      ],
      ['JSON KB fa', (r) => f1((r.result?.serialization?.frameAxis?.bytes ?? NaN) / 1024)],
      ['JSON KB ps', (r) => f1((r.result?.serialization?.perSlice?.bytes ?? NaN) / 1024)],
      ['deser fa', (r) => r.result?.serialization?.frameAxis?.deserializeMs ?? '-'],
      ['deser ps', (r) => r.result?.serialization?.perSlice?.deserializeMs ?? '-'],
      ['reconcile rev', (r) => r.result?.reconcile?.reversedMs ?? '-'],
      ['err', (r) => (r.error ? 'ERR' : '')],
    ]);
  }
  if (results.strategies) {
    console.log(
      '\nH2a — image strategies (300 x 512² CT, no annotations). Latency = apply -> OSD draw showing it.',
    );
    table(results.strategies, [
      ['config', (r) => r.name],
      ['setup ms', (r) => f1(r.setup?.totalMs)],
      ['mem MB', (r) => f1(r.memory?.setupDeltaMB)],
      ['lat p50', (r) => f1(r.latency?.latencyMs?.p50)],
      ['lat p95', (r) => f1(r.latency?.latencyMs?.p95)],
      ['frames p50', (r) => f1(r.latency?.latencyFrames?.p50)],
      ['blank', (r) => r.latency?.blankFrames ?? '-'],
      ['fps', (r) => f1(r.scroll60?.displayFps)],
      ['shown/s', (r) => f1(r.scroll60?.shownSlicesPerSec)],
      ['fps(await)', (r) => f1(r.scroll60d?.displayFps)],
      ['shown/s(await)', (r) => f1(r.scroll60d?.shownSlicesPerSec)],
      ['blank(await)', (r) => r.scroll60d?.blankFrames ?? '-'],
      ['draw p50', (r) => f1(r.scroll60?.osdDrawMs?.p50)],
      ['static draw p50', (r) => f1(r.redraw?.osdDrawMs?.p50)],
      ['paint ms', (r) => f1(r.scroll60?.paintMsPerFrame)],
      [
        'pixelOK',
        (r) =>
          r.verify ? `${r.verify.checked - r.verify.pixelMismatches}/${r.verify.checked}` : '-',
      ],
      ['vpt diff', (r) => (r.scroll60?.sync ? r.scroll60.sync.vptMaxAbsDiff : '-')],
      ['zoom drift', (r) => (r.scroll60?.sync ? r.scroll60.sync.zoomRelDrift : '-')],
      ['err', (r) => (r.error ? 'ERR' : '')],
    ]);
  }
  if (results.layers) {
    console.log('\nH2b — annotation swap per slice (mutable tile, decorations on).');
    table(results.layers, [
      ['config', (r) => r.name],
      ['init ms', (r) => f1(r.setup?.layerInitMs)],
      ['mem MB', (r) => f1(r.memory?.setupDeltaMB)],
      ['ann p50', (r) => f1(r.latency?.applyAnnMs?.p50)],
      ['ann p95', (r) => f1(r.latency?.applyAnnMs?.p95)],
      ['deco p50', (r) => f1(r.latency?.applyDecoMs?.p50)],
      ['render p50', (r) => f1(r.latency?.fabricRenderMs?.p50)],
      ['lat p95', (r) => f1(r.latency?.latencyMs?.p95)],
      ['fps@60', (r) => f1(r.scroll60?.displayFps)],
      ['shown/s', (r) => f1(r.scroll60?.shownSlicesPerSec)],
      ['incoherent', (r) => r.scroll60?.incoherentFrames ?? '-'],
      ['long', (r) => r.scroll60?.longFrames ?? '-'],
      ['err', (r) => (r.error ? 'ERR' : '')],
    ]);
  }
  if (results.cine) {
    console.log('\nH3 — cine 100 x 800x600 RGB, 3 annotations/frame + live decorations.');
    table(results.cine, [
      ['config', (r) => r.name],
      ['prep ms', (r) => f1(r.result?.prepMs)],
      ['mem MB', (r) => f1(r.memory?.deltaMB)],
      ['achieved fps', (r) => f1(r.result?.achievedFps)],
      ['dropped %', (r) => f1(r.result?.droppedPct)],
      ['incoherent', (r) => r.result?.incoherentFrames ?? '-'],
      ['time/pixel mismatch', (r) => r.result?.timeVsPixelMismatches ?? '-'],
      ['element dropped', (r) => r.result?.videoDroppedByElement ?? '-'],
      ['apply p95', (r) => f1(r.result?.applyMs?.p95)],
      ['frame ms p95', (r) => f1(r.result?.frameIntervalMs?.p95)],
      ['err', (r) => (r.error ? 'ERR' : '')],
    ]);
  }
  if (results.solid) {
    console.log(
      '\nSolid binding (public frameCellOptions), median (min-max) over repetitions; passes cold / revisit / window.',
    );
    const agg = aggregateSolid(results.solid);
    const cell = (r, pass, k) => fmtSpread(r.passes[pass]?.[k]);
    table(agg, [
      ['config', (r) => r.name],
      ['reps', (r) => r.reps],
      ['cold slices/s', (r) => cell(r, 'cold', 'slicesPerSec')],
      ['cold incoh', (r) => cell(r, 'cold', 'incoherent')],
      ['revisit slices/s', (r) => cell(r, 'revisit', 'slicesPerSec')],
      ['revisit incoh', (r) => cell(r, 'revisit', 'incoherent')],
      ['window slices/s', (r) => cell(r, 'window', 'slicesPerSec')],
      ['window incoh', (r) => cell(r, 'window', 'incoherent')],
      ['fps (revisit)', (r) => cell(r, 'revisit', 'fps')],
      ['sync p95', (r) => cell(r, 'revisit', 'syncMsP95')],
      ['blank', (r) => cell(r, 'revisit', 'blank')],
      ['edit add ms', (r) => fmtSpread(r.editAddMsP50)],
      ['heap MB', (r) => cell(r, 'window', 'heapMB')],
      ['PSS MB', (r) => fmtSpread(r.memDeltaMB)],
      ['view kept', (r) => (r.viewKept ? 'yes' : `no: ${JSON.stringify(r.viewAfter)}`)],
      ['err', (r) => (r.errors.length ? `ERR x${r.errors.length}` : '')],
    ]);
    results.solidSummary = agg;
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const server = await startServer();
const { server: browserServer, browser, pid } = await launch();
const results = {
  startedAt: new Date().toISOString(),
  quick: QUICK,
  groups: GROUPS,
  chromium: CHANNEL ?? CHROMIUM ?? 'playwright-default',
  headed: HEADED,
};
try {
  if (GROUPS.includes('env')) {
    const { context, page } = await openPage(browser);
    results.env = await call(page, 'env');
    results.env.baseline = await call(page, 'baseline', QUICK ? 1000 : 3000);
    results.env.idleMemory = pssMB(pid);
    results.env.loadAvg = load();
    await context.close();
  }
  if (GROUPS.includes('model')) results.model = await groupModel(browser);
  if (GROUPS.includes('strategies')) results.strategies = await groupStrategies(browser, pid);
  if (GROUPS.includes('layers')) results.layers = await groupLayers(browser, pid);
  if (GROUPS.includes('cine')) results.cine = await groupCine(browser, pid);
  if (GROUPS.includes('solid')) results.solid = await groupSolid(browser, pid);
} finally {
  await browser.close().catch(() => {});
  await browserServer.close().catch(() => {});
  await server.close();
}
results.finishedAt = new Date().toISOString();
summary(results);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(APP, 'results', 'latest.json'), JSON.stringify(results, null, 2));
console.log(`\nwrote ${path.relative(process.cwd(), path.join(OUT, 'results.json'))}`);
