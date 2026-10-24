/**
 * Turn a bench results.json into (1) a compact representative JSON and (2)
 * the markdown tables REPORT.md quotes, so the report is generated from the
 * data rather than transcribed.
 *
 *   node scripts/summarize.mjs results/<run>/results.json [--out results/representative.json]
 *
 * Solid rows are aggregated over their repetitions: median and range per
 * configuration and pass (see solid-aggregate.mjs).
 */
import fs from 'node:fs';
import { aggregateSolid, fmtSpread } from './solid-aggregate.mjs';

const argv = process.argv.slice(2);
const input = argv[0];
if (!input) throw new Error('usage: summarize.mjs <results.json> [--out path]');
const outIdx = argv.indexOf('--out');
const out = outIdx === -1 ? undefined : argv[outIdx + 1];
const r = JSON.parse(fs.readFileSync(input, 'utf8'));

const n = (x, d = 1) =>
  x === null || x === undefined || Number.isNaN(x) ? null : Number(Number(x).toFixed(d));
const pick = (s) => (s ? { p50: n(s.p50, 2), p95: n(s.p95, 2), max: n(s.max, 2), n: s.n } : null);

const compact = {
  source: input,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  chromium: r.chromium,
  env: r.env
    ? {
        userAgent: r.env.userAgent,
        webgl2Renderer: r.env.webgl2Renderer,
        hardwareConcurrency: r.env.hardwareConcurrency,
        crossOriginIsolated: r.env.crossOriginIsolated,
        baselineFps: r.env.baseline?.displayFps,
        idleMemoryMB: r.env.idleMemory?.total,
        loadAvg: r.env.loadAvg,
      }
    : undefined,
  // H1 model costs are already medians of small numbers: kept as measured.
  model: (r.model ?? []).map((x) => ({ config: x.name, error: x.error, ...x.result })),
  strategies: (r.strategies ?? []).map((x) => ({
    config: x.name,
    error: x.error,
    loadAvg: x.loadAvgBefore,
    setupMs: n(x.setup?.totalMs, 0),
    memDeltaMB: x.memory?.setupDeltaMB,
    latencyMs: pick(x.latency?.latencyMs),
    latencyFrames: pick(x.latency?.latencyFrames),
    blankPerStep: x.latency ? n(x.latency.blankFrames / Math.max(1, x.latency.applies), 2) : null,
    scrollLatest: x.scroll60 && {
      fps: n(x.scroll60.displayFps),
      shownPerSec: n(x.scroll60.shownSlicesPerSec),
      blank: x.scroll60.blankFrames,
    },
    scrollAwaitDrawn: x.scroll60d && {
      fps: n(x.scroll60d.displayFps),
      shownPerSec: n(x.scroll60d.shownSlicesPerSec),
      blank: x.scroll60d.blankFrames,
    },
    osdDrawMsDuringScroll: pick(x.scroll60?.osdDrawMs),
    osdDrawMsStatic: pick(x.redraw?.osdDrawMs),
    paintMsPerFrame: n(x.scroll60?.paintMsPerFrame, 2),
    pixelVerify: x.verify && { checked: x.verify.checked, mismatches: x.verify.pixelMismatches },
    sync: x.scroll60?.sync,
    consoleErrors: x.scroll60?.consoleErrors,
  })),
  layers: (r.layers ?? []).map((x) => ({
    config: x.name,
    error: x.error,
    loadAvg: x.loadAvgBefore,
    layerInitMs: n(x.setup?.layerInitMs, 0),
    memDeltaMB: x.memory?.setupDeltaMB,
    annSwapMs: pick(x.latency?.applyAnnMs),
    decoMs: pick(x.latency?.applyDecoMs),
    fabricRenderMs: pick(x.latency?.fabricRenderMs),
    imageLatencyMs: pick(x.latency?.latencyMs),
    scroll: x.scroll60 && {
      fps: n(x.scroll60.displayFps),
      shownPerSec: n(x.scroll60.shownSlicesPerSec),
      incoherent: x.scroll60.incoherentFrames,
      longFrames: x.scroll60.longFrames,
      frames: x.scroll60.frames,
    },
  })),
  cine: (r.cine ?? []).map((x) => ({
    config: x.rep !== undefined ? `${x.name} #${x.rep + 1}` : x.name,
    error: x.error,
    loadAvg: x.loadAvgBefore,
    prepMs: n(x.result?.prepMs, 0),
    memDeltaMB: x.memory?.deltaMB,
    achievedFps: n(x.result?.achievedFps),
    droppedPct: n(x.result?.droppedPct),
    incoherent: x.result?.incoherentFrames,
    applyMs: pick(x.result?.applyMs),
    paintMsPerFrame: n(x.result?.paintMsPerFrame, 2),
    osdDrawMs: pick(x.result?.osdDrawMs),
    timeVsPixelMismatches: x.result?.timeVsPixelMismatches,
    elementDropped: x.result?.videoDroppedByElement,
    calibratedFrames: x.result?.calibratedFrames,
    encodedBytes: x.result?.encodedBytes,
  })),
  solid: r.solid ? aggregateSolid(r.solid) : [],
  // Set when the Solid rows come from a separate run merged into this file.
  solidRun: r.solidRun && {
    startedAt: r.solidRun.startedAt,
    finishedAt: r.solidRun.finishedAt,
    loadAvg: r.solidRun.env?.loadAvg,
    note: r.solidRun.note,
  },
};

if (out) fs.writeFileSync(out, JSON.stringify(compact, null, 1) + '\n');

// ── markdown ────────────────────────────────────────────────────────────
const md = (header, rows) => {
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of rows)
    lines.push(
      `| ${row.map((c) => (c === null || c === undefined ? '–' : String(c))).join(' | ')} |`,
    );
  return lines.join('\n');
};
const lm = (x) => (Array.isArray(x) ? x[0] : x);

console.log('\n### Strategies\n');
console.log(
  md(
    [
      'config',
      'setup ms',
      'mem MB',
      'latency p50/p95 ms',
      'extra paints p50',
      'blank/step',
      'fps / slices/s (latest)',
      'fps / slices/s / blank (await-drawn)',
      'OSD draw p50 scroll / static ms',
      'pixel check',
      'vpt diff',
      'load',
    ],
    compact.strategies.map((s) => [
      s.config,
      s.setupMs,
      s.memDeltaMB,
      s.latencyMs ? `${s.latencyMs.p50} / ${s.latencyMs.p95}` : null,
      s.latencyFrames?.p50,
      s.blankPerStep,
      s.scrollLatest ? `${s.scrollLatest.fps} / ${s.scrollLatest.shownPerSec}` : null,
      s.scrollAwaitDrawn
        ? `${s.scrollAwaitDrawn.fps} / ${s.scrollAwaitDrawn.shownPerSec} / ${s.scrollAwaitDrawn.blank}`
        : null,
      `${s.osdDrawMsDuringScroll?.p50 ?? '–'} / ${s.osdDrawMsStatic?.p50 ?? '–'}`,
      s.pixelVerify
        ? `${s.pixelVerify.checked - s.pixelVerify.mismatches}/${s.pixelVerify.checked}`
        : null,
      s.sync?.vptMaxAbsDiff,
      lm(s.loadAvg),
    ]),
  ),
);
console.log('\n### Annotation layers\n');
console.log(
  md(
    [
      'config',
      'init ms',
      'mem MB',
      'swap p50/p95 ms',
      'decorations p50/p95 ms',
      'Fabric render p50/p95 ms',
      'scroll fps',
      'slices/s',
      'incoherent / frames',
      'long frames',
      'load',
    ],
    compact.layers.map((s) => [
      s.config,
      s.layerInitMs,
      s.memDeltaMB,
      s.annSwapMs ? `${s.annSwapMs.p50} / ${s.annSwapMs.p95}` : null,
      s.decoMs ? `${s.decoMs.p50} / ${s.decoMs.p95}` : null,
      s.fabricRenderMs ? `${s.fabricRenderMs.p50} / ${s.fabricRenderMs.p95}` : null,
      s.scroll?.fps,
      s.scroll?.shownPerSec,
      s.scroll ? `${s.scroll.incoherent} / ${s.scroll.frames}` : null,
      s.scroll?.longFrames,
      lm(s.loadAvg),
    ]),
  ),
);
console.log('\n### Cine\n');
console.log(
  md(
    [
      'config',
      'prep ms',
      'mem MB',
      'achieved fps',
      'dropped %',
      'incoherent',
      'apply p50/p95 ms',
      'paint ms',
      'OSD draw p50 ms',
      'time/pixel mismatch',
      'element dropped',
      'load',
    ],
    compact.cine.map((s) => [
      s.config,
      s.prepMs,
      s.memDeltaMB,
      s.achievedFps,
      s.droppedPct,
      s.incoherent,
      s.applyMs ? `${s.applyMs.p50} / ${s.applyMs.p95}` : null,
      s.paintMsPerFrame,
      s.osdDrawMs?.p50,
      s.timeVsPixelMismatches,
      s.elementDropped,
      lm(s.loadAvg),
    ]),
  ),
);
if (compact.solid.length > 0) {
  console.log('\n### Solid binding: median (min-max) over repetitions\n');
  const c = (row, pass, k) => fmtSpread(row.passes[pass]?.[k]);
  console.log(
    md(
      [
        'config',
        'reps',
        'cold slices/s',
        'cold incoherent',
        'revisit slices/s',
        'revisit incoherent',
        'window (W) slices/s',
        'window incoherent',
        'revisit fps',
        'sync work p95 ms',
        'edit add ms',
        'heap MB (window)',
        'PSS MB',
        'view kept',
        'load',
      ],
      compact.solid.map((row) => [
        row.name,
        row.reps,
        c(row, 'cold', 'slicesPerSec'),
        c(row, 'cold', 'incoherent'),
        c(row, 'revisit', 'slicesPerSec'),
        c(row, 'revisit', 'incoherent'),
        `${c(row, 'window', 'slicesPerSec')} (W=${row.passes.window?.window ?? '-'})`,
        c(row, 'window', 'incoherent'),
        c(row, 'revisit', 'fps'),
        c(row, 'revisit', 'syncMsP95'),
        fmtSpread(row.editAddMsP50),
        c(row, 'window', 'heapMB'),
        fmtSpread(row.memDeltaMB),
        row.viewKept
          ? 'yes'
          : `no (${JSON.stringify(row.viewBefore)} -> ${JSON.stringify(row.viewAfter)})`,
        `${row.loadAvg?.[0]}-${row.loadAvg?.[1]}`,
      ]),
    ),
  );
}
