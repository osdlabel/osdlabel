#!/usr/bin/env node
/**
 * The DICOM PoC benchmark — one command:
 *
 *   pnpm --filter @osdlabel/poc-dicom bench [-- options]
 *
 *   --reps N        repetitions for timed sections (default 3)
 *   --no-browser    skip the Chromium sections (WSI tiles, annotate flow)
 *   --no-remote     skip the real-network probe against IDC's bucket
 *   --survey        also run the 400-instance IDC header survey (network)
 *   --headed        show the browser (use with POC_CHROMIUM=<desktop Chrome>)
 *   --python PATH   Python with highdicom + dicom3tools (default: POC_PYTHON,
 *                   then ./.venv from `pnpm --filter @osdlabel/poc-dicom setup:python`)
 *   --port N        dev-server port (default 5420)
 *
 * Fetches the IDC data if missing (scripts/fetch-data.mjs), then measures
 * H1 (ingest: mapping evidence, parser correctness/speed, bundle cost),
 * H3 (export round trip + dciodvfy/highdicom validation) and H2 (DICOM WSI in
 * OpenSeadragon: first paint, tile latency, per source mode and codec; and the
 * stock <Annotator> end to end). Writes results/bench-<stamp>.json and
 * results/latest.json and prints a summary.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchAll, MANIFEST, DATA_DIR } from './fetch-data.mjs';
import { runParserBench } from './lib/parser-bench.mjs';
import { measureBundles } from './lib/bundle-size.mjs';
import { ingestEvidence } from './lib/ingest-evidence.mjs';
import { runExportExperiment } from './lib/export-experiment.mjs';
import { remoteProbe } from './lib/remote-probe.mjs';
import { startServer, launch, chromiumPath } from './lib/browser.mjs';
import { runAnnotateFlow } from './lib/annotate-flow.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(APP, 'results');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
const opts = {
  reps: Number(arg('--reps', 3)),
  browser: !has('--no-browser'),
  remote: !has('--no-remote'),
  survey: has('--survey'),
  headed: has('--headed'),
  port: Number(arg('--port', 5420)),
  python:
    arg('--python') ??
    process.env.POC_PYTHON ??
    (fs.existsSync(path.join(APP, '.venv', 'bin', 'python')) ? path.join(APP, '.venv', 'bin', 'python') : null),
};

const log = (...a) => console.log('[bench]', ...a);
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const quantile = (xs, q) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const r1 = (x) => (x === null || x === undefined ? null : +Number(x).toFixed(1));

function python(script, args) {
  if (!opts.python) return null;
  try {
    const out = execFileSync(opts.python, ['-I', path.join(APP, 'scripts', 'py', script), ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: os.tmpdir(),
    });
    return JSON.parse(out);
  } catch (err) {
    log(`python ${script} failed: ${String(err.message).slice(0, 200)}`);
    return null;
  }
}

function summariseValidation(v) {
  if (!v) return null;
  const out = {};
  for (const [file, r] of Object.entries(v.files)) {
    const warnings = (r.dciodvfy.warnings ?? []).filter(
      (w) => !/DICOMDIR|Retired Person Name form/.test(w),
    );
    out[file] = {
      dciodvfyAvailable: r.dciodvfy.available !== false,
      dciodvfyErrors: r.dciodvfy.errors?.length ?? null,
      dciodvfyWarnings: warnings.length,
      errorLines: (r.dciodvfy.errors ?? []).slice(0, 5),
      warningLines: warnings.slice(0, 5),
      highdicomOk: r.highdicom_ok,
      highdicomError: r.highdicom_error,
      highdicom: r.highdicom,
    };
  }
  return out;
}

// ── WSI matrix ─────────────────────────────────────────────────────────────

const ZOOM_TARGETS = {
  // Tissue, picked from the home view (fractions of the base level).
  'sm-jpeg': [
    [0.82, 0.44],
    [0.18, 0.6],
  ],
  'sm-j2k': [
    [0.556, 0.7],
    [0.5, 0.05],
  ],
};
const WSI_CASES = [
  { role: 'sm-jpeg', mode: 'part10', drawer: 'canvas' },
  { role: 'sm-jpeg', mode: 'range', drawer: 'canvas' },
  { role: 'sm-jpeg', mode: 'dicomweb', drawer: 'canvas' },
  { role: 'sm-jpeg', mode: 'dicomweb', drawer: 'canvas', latency: 50 },
  { role: 'sm-jpeg', mode: 'dicomweb', drawer: 'webgl' },
  { role: 'sm-j2k', mode: 'part10', drawer: 'canvas' },
  { role: 'sm-j2k', mode: 'dicomweb', drawer: 'canvas' },
];

async function runWsiCase(browser, origin, c) {
  await fetch(`${origin}/dicomweb-config?latency=${c.latency ?? 0}&reset=1`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/wsi.html?role=${c.role}&mode=${c.mode}&drawer=${c.drawer}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 180000 });
    const base = await page.evaluate(() => {
      const w = window.__wsi;
      return {
        drawer: w.drawer,
        levels: w.pyramid.levels,
        metadataMs: w.metadataMs,
        firstTileMs: w.firstTileMs,
        home: w.home,
      };
    });
    const zooms = [];
    for (const [fx, fy] of ZOOM_TARGETS[c.role]) {
      zooms.push(
        await page.evaluate(
          async ([fx2, fy2]) => {
            const l = window.__wsi.pyramid.levels.at(-1);
            return window.__wsi.zoomToBase(l.width * fx2, l.height * fy2);
          },
          [fx, fy],
        ),
      );
    }
    const j2k = await page.evaluate(() => window.__wsi.j2kWorkerMs());
    const server = await (await fetch(`${origin}/dicomweb-config`)).json();
    const phases = [base.home, ...zooms];
    const fetchMs = phases.flatMap((p) => p.tileFetchMs);
    const decodeMs = phases.flatMap((p) => p.tileDecodeMs);
    return {
      drawer: base.drawer,
      levels: base.levels,
      metadataMs: base.metadataMs,
      firstTileMs: base.firstTileMs,
      homeMs: base.home.ms,
      homeTiles: base.home.tiles,
      zoomMs: zooms.map((z) => z.ms),
      zoomTiles: zooms.map((z) => z.tiles),
      failedTiles: phases.reduce((n, p) => n + p.failed, 0),
      tileFetchMedianMs: median(fetchMs),
      tileFetchP90Ms: quantile(fetchMs, 0.9),
      tileDecodeMedianMs: median(decodeMs),
      tileDecodeP90Ms: quantile(decodeMs, 0.9),
      j2kWorkerMedianMs: median(j2k),
      tileBytes: phases.reduce((n, p) => n + p.bytes, 0),
      serverRequests: server.requests,
      serverBytes: server.bytes,
    };
  } finally {
    await context.close();
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const started = new Date();
const results = {
  meta: {
    started: started.toISOString(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    loadavgStart: os.loadavg(),
    node: process.version,
    opts: { ...opts, python: opts.python ? 'yes' : 'no' },
    gitHead: (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    })(),
    idcIndexVersion: MANIFEST.idc_index_data_version,
  },
  h1: {},
  h2: {},
  h3: {},
};

log('fetching data (if missing)…');
results.meta.data = await fetchAll();

log('H1: ingest evidence…');
results.h1.ingest = ingestEvidence(DATA_DIR, MANIFEST);

log('H1: parser comparison…');
const truth = python('truth.py', [DATA_DIR]);
results.h1.parsers = runParserBench({ dataDir: DATA_DIR, truth, reps: Math.max(3, opts.reps) });
results.h1.parsers.truth = truth ? 'pydicom' : 'none (no python): correctness not checked';

log('H1: bundle sizes…');
results.h1.bundles = await measureBundles(APP);

if (opts.survey) {
  log('H1: IDC header survey (network)…');
  const { runSurvey } = await import('./survey.mjs');
  const s = await runSurvey({ bytes: 65536 });
  results.h1.survey = s.summary;
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, 'survey.json'), JSON.stringify(s, null, 1));
} else if (fs.existsSync(path.join(RESULTS, 'survey.json'))) {
  results.h1.survey = { ...JSON.parse(fs.readFileSync(path.join(RESULTS, 'survey.json'), 'utf8')).summary, _from: 'results/survey.json (previous --survey run)' };
}

log('H3: export round trip…');
const exportDir = path.join(RESULTS, 'export');
const exp = runExportExperiment({ dataDir: DATA_DIR, outDir: exportDir });
fs.writeFileSync(
  path.join(exportDir, 'expectations.json'),
  JSON.stringify(exp, (k, v) => (v === Infinity ? 'Infinity' : v), 1),
);
const validation = python('validate.py', [exportDir, path.join(exportDir, 'expectations.json')]);
results.h3 = {
  cases: exp.cases.map(({ expected, ...rest }) => rest),
  buildMs: exp.timings,
  validation: summariseValidation(validation),
  transformCrossCheck: validation?.transforms ?? null,
  validators: validation ? { highdicom: validation.highdicom, pydicom: validation.pydicom } : 'skipped (no python)',
};

if (opts.browser) {
  log(`H2: browser sections (chromium: ${chromiumPath()})…`);
  const { server, origin } = await startServer(opts.port);
  const browser = await launch({ headed: opts.headed });
  results.meta.chromium = browser.version();
  try {
    // Warm-up: let Vite pre-bundle dependencies, and the emulated DICOMweb
    // server build its index, before anything is timed.
    await fetch(`${origin}/series-of.json?role=sm-jpeg`);
    for (const url of [
      '/wsi.html?role=sm-jpeg&mode=part10&drawer=canvas',
      '/wsi.html?role=sm-j2k&mode=dicomweb&drawer=canvas',
    ]) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(origin + url);
      await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 180000 }).catch(() => {});
      await ctx.close();
    }
    const wsi = [];
    for (const c of WSI_CASES) {
      const runs = [];
      for (let rep = 0; rep < opts.reps; rep++) {
        log(`  WSI ${c.role} ${c.mode} ${c.drawer}${c.latency ? ` +${c.latency}ms` : ''} rep ${rep + 1}/${opts.reps}`);
        runs.push(await runWsiCase(browser, origin, c));
      }
      const pick = (k) => median(runs.map((r) => r[k]));
      wsi.push({
        ...c,
        reps: runs.length,
        drawerActual: runs[0].drawer,
        levels: runs[0].levels,
        metadataMs: r1(pick('metadataMs')),
        firstTileMs: r1(pick('firstTileMs')),
        homeMs: r1(pick('homeMs')),
        homeTiles: pick('homeTiles'),
        zoomMs: [0, 1].map((i) => r1(median(runs.map((r) => r.zoomMs[i])))),
        zoomTiles: [0, 1].map((i) => median(runs.map((r) => r.zoomTiles[i]))),
        failedTiles: runs.reduce((n, r) => n + r.failedTiles, 0),
        tileFetchMedianMs: r1(pick('tileFetchMedianMs')),
        tileFetchP90Ms: r1(pick('tileFetchP90Ms')),
        tileDecodeMedianMs: r1(pick('tileDecodeMedianMs')),
        tileDecodeP90Ms: r1(pick('tileDecodeP90Ms')),
        j2kWorkerMedianMs: r1(pick('j2kWorkerMedianMs')),
        tileBytes: pick('tileBytes'),
        serverRequests: pick('serverRequests'),
        serverBytes: pick('serverBytes'),
        raw: runs.map((r) => ({ homeMs: r1(r.homeMs), zoomMs: r.zoomMs.map(r1), firstTileMs: r1(r.firstTileMs) })),
      });
    }
    results.h2.wsi = wsi;

    log('  annotate flow (stock <Annotator>, DICOM in → DICOM out)…');
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const annotateDir = path.join(RESULTS, 'annotate');
    const flow = await runAnnotateFlow(page, origin, annotateDir);
    await ctx.close();
    const files = flow.exported.map((f) => path.join(annotateDir, f.name));
    const v = files.length ? python('validate.py', ['--files', ...files]) : null;
    results.h2.annotate = { ...flow, validation: summariseValidation(v) };
  } finally {
    await browser.close();
    await server.close();
  }
}

if (opts.remote) {
  log('H2: real-network Range probe against the IDC bucket…');
  try {
    results.h2.remote = await remoteProbe(MANIFEST);
  } catch (err) {
    results.h2.remote = { error: String(err?.message ?? err) };
  }
}

results.meta.loadavgEnd = os.loadavg();
results.meta.durationS = +((Date.now() - started.getTime()) / 1000).toFixed(1);
fs.mkdirSync(RESULTS, { recursive: true });
const stamp = started.toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(RESULTS, `bench-${stamp}.json`), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(RESULTS, 'latest.json'), JSON.stringify(results, null, 1));

// ── summary ────────────────────────────────────────────────────────────────

console.log('\n== H1 ingest: what the adapter derives (representative instance per series) ==');
console.table(
  Object.fromEntries(
    Object.entries(results.h1.ingest).map(([role, e]) => [
      role,
      {
        mod: e.modality,
        spacing: e.pixelSpacing ? `${e.pixelSpacing.x} ${e.pixelSpacing.unit}` : '-',
        from: e.pixelSpacing ? `${e.pixelSpacing.source}@${e.pixelSpacing.plane}` : '-',
        windows: e.display.windows.length,
        invert: e.display.invert,
        frames: `${e.frames} (${e.timing.axis})`,
        usRegions: e.ultrasoundRegions.length,
        plane: e.plane ? (e.plane.oblique ? 'oblique' : 'axis-aligned') : '-',
        hdrKB: +(e.headerBytes / 1024).toFixed(1),
      },
    ]),
  ),
);
console.log('== H1 parsers: files correct vs pydicom; median ms per role (parse + extract) ==');
console.table(
  Object.fromEntries(
    Object.entries(results.h1.parsers.correctness).map(([k, c]) => [k, { files: c.files, correct: c.ok, mismatched: c.failures.length, threw: c.errors.length }]),
  ),
);
console.table(Object.fromEntries(Object.entries(results.h1.parsers.perRole).map(([k, v]) => [k, v.ms])));
console.log('== H1 bundle cost (esbuild, minified) ==');
console.table(Object.fromEntries(Object.entries(results.h1.bundles).map(([k, v]) => [k, { rawKB: +(v.raw / 1024).toFixed(1), gzipKB: +(v.gzip / 1024).toFixed(1) }])));
console.log('== H3 export round trip ==');
console.table(
  Object.fromEntries(
    results.h3.cases.map((c) => [
      c.file,
      {
        kind: `${c.kind} ${c.mode}`,
        bytes: c.bytes,
        shapesTypeKept: c.shapes !== undefined ? `${c.typesPreserved}/${c.shapes}` : '-',
        maxCoordErrPx: c.maxCoordErrorPx ?? '-',
        maxMeasRelErr: c.maxMeasurementRelError ?? '-',
        segExact: c.exact ?? '-',
        dciodvfyErrors: results.h3.validation?.[c.file]?.dciodvfyErrors ?? 'n/a',
        highdicom: results.h3.validation?.[c.file]?.highdicomOk ?? 'n/a',
      },
    ]),
  ),
);
if (results.h3.transformCrossCheck) {
  console.log('image→patient/slide vs highdicom ImageToReferenceTransformer (max |Δ| mm):', JSON.stringify(results.h3.transformCrossCheck));
}
if (results.h2.wsi) {
  console.log('== H2 DICOM WSI in OpenSeadragon (median of reps; ms) ==');
  console.table(
    results.h2.wsi.map((w) => ({
      case: `${w.role} ${w.mode} ${w.drawerActual}${w.latency ? ` +${w.latency}ms` : ''}`,
      meta: w.metadataMs,
      firstTile: w.firstTileMs,
      home: w.homeMs,
      homeTiles: w.homeTiles,
      zoomA: w.zoomMs[0],
      zoomB: w.zoomMs[1],
      fetchMed: w.tileFetchMedianMs,
      decodeMed: w.tileDecodeMedianMs,
      j2kWorker: w.j2kWorkerMedianMs,
      requests: w.serverRequests,
      failed: w.failedTiles,
    })),
  );
}
if (results.h2.annotate) {
  console.log('== H2/H3 end to end: stock <Annotator> on DICOM, exported and validated ==');
  console.table(
    Object.fromEntries(
      results.h2.annotate.exported.map((f) => [
        f.name,
        { kind: f.kind, items: f.items, bytes: f.bytes, dciodvfyErrors: results.h2.annotate.validation?.[f.name]?.dciodvfyErrors ?? 'n/a', highdicom: results.h2.annotate.validation?.[f.name]?.highdicomOk ?? 'n/a' },
      ]),
    ),
  );
}
if (results.h2.remote) console.log('== H2 real network (IDC bucket, HTTP Range) ==\n', JSON.stringify(results.h2.remote));
console.log(`\nwrote results/bench-${stamp}.json (${results.meta.durationS}s; load ${results.meta.loadavgStart.map((x) => x.toFixed(1)).join('/')} → ${results.meta.loadavgEnd.map((x) => x.toFixed(1)).join('/')})`);
