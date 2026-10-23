/**
 * Turn a bench results.json into (1) a compact representative JSON and (2)
 * the markdown tables REPORT.md quotes, so the report is generated from the
 * data rather than transcribed.
 *
 *   node scripts/summarize.mjs results/<run>/results.json [--out results/representative.json]
 *                              [--extra-solid label=path ...]
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const input = argv[0];
if (!input)
  throw new Error('usage: summarize.mjs <results.json> [--out path] [--extra-solid label=path]');
const outIdx = argv.indexOf('--out');
const out = outIdx === -1 ? undefined : argv[outIdx + 1];
const extras = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--extra-solid') {
    const [label, file] = argv[i + 1].split('=');
    extras.push({ label, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
}
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
    config: x.name,
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
  solid: [{ label: 'optimized (HEAD)', data: r }, ...extras].map(({ label, data }) => ({
    binding: label,
    rows: (data.solid ?? []).map((x) => ({
      config: x.name,
      error: x.error,
      loadAvg: x.loadAvgBefore,
      cold: x.scripted && {
        fps: n(x.scripted.displayFps),
        shownPerSec: n(x.scripted.shownSlicesPerSec),
      },
      warm: x.scriptedWarm && {
        fps: n(x.scriptedWarm.displayFps),
        shownPerSec: n(x.scriptedWarm.shownSlicesPerSec),
        incoherent: x.scriptedWarm.incoherentFrames,
        blank: x.scriptedWarm.blankFrames,
        syncWorkMsP95: n(x.scriptedWarm.applyMs?.p95, 2),
      },
      realWheel: x.realWheel && {
        fps: n(x.realWheel.displayFps),
        shownPerSec: n(x.realWheel.shownSlicesPerSec),
        eventsSent: x.realWheel.wheelEventsSent,
      },
      viewBefore: x.viewBefore,
      viewAfter: x.viewAfter,
      memDeltaMB: x.memory?.deltaMB,
    })),
  })),
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
for (const b of compact.solid) {
  console.log(`\n### Solid binding — ${b.binding}\n`);
  console.log(
    md(
      [
        'config',
        'cold fps / slices/s',
        'warm fps / slices/s',
        'incoherent',
        'blank',
        'sync work p95 ms',
        'real wheel fps / slices/s (events)',
        'view before -> after',
        'mem MB',
        'load',
      ],
      b.rows.map((s) => [
        s.config,
        s.cold ? `${s.cold.fps} / ${s.cold.shownPerSec}` : null,
        s.warm ? `${s.warm.fps} / ${s.warm.shownPerSec}` : null,
        s.warm?.incoherent,
        s.warm?.blank,
        s.warm?.syncWorkMsP95,
        s.realWheel
          ? `${s.realWheel.fps} / ${s.realWheel.shownPerSec} (${s.realWheel.eventsSent})`
          : null,
        s.viewAfter
          ? `rot ${s.viewBefore?.rotation}°, ${s.viewBefore?.zoomOverHome}x -> rot ${s.viewAfter.rotation}°, ${s.viewAfter.zoomOverHome}x`
          : null,
        s.memDeltaMB,
        lm(s.loadAvg),
      ]),
    ),
  );
}
