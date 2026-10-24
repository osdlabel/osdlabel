/** Console summary of a results JSON (the file itself is the record). */

const f = (v, d = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v ?? '-');

function table(title, rows, cols) {
  if (!rows || rows.length === 0) return;
  console.log(`\n## ${title}`);
  const head = cols.map((c) => c[0]);
  const body = rows.map((r) => cols.map((c) => String(c[1](r))));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(line(w.map((n) => '-'.repeat(n))));
  for (const b of body) console.log(line(b));
}

const median = (xs) => {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q);
  if (a.length === 0) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Collapse repeated MPR loops (same scenario, method, decoration mode and
 * annotation count) into one row: fps median and [min, max] across reps, and
 * the median across reps of each per-rep statistic.
 */
export function aggregateLoops(loops) {
  const groups = new Map();
  for (const l of loops ?? []) {
    const key = [l.scenario, l.method, l.decorationMode ?? 'all', l.annotations].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  return [...groups.values()].map((ls) => {
    const first = ls[0];
    const phase = (name, stat) => median(ls.map((l) => l.phases?.[name]?.[stat]));
    const fps = ls.map((l) => l.fps);
    return {
      scenario: first.scenario,
      method: first.method,
      decorationMode: first.decorationMode ?? 'all',
      annotations: first.annotations,
      planesPerFrame: first.planesPerFrame,
      reps: ls.length,
      fpsMedian: median(fps),
      fpsMin: Math.min(...fps),
      fpsMax: Math.max(...fps),
      fpsAll: fps,
      frameP95: median(ls.map((l) => l.frameMs?.p95)),
      updateMedian: median(ls.map((l) => l.updateMs?.median)),
      updateP95: median(ls.map((l) => l.updateMs?.p95)),
      phases: Object.fromEntries(
        [
          'render',
          'reslice',
          'upload',
          'osdDraw',
          'fabric',
          'decorations',
          'decoProviders',
          'decoLayer',
          'decoRenderAll',
        ].map((n) => [n, { median: phase(n, 'median'), p95: phase(n, 'p95') }]),
      ),
      decorationsPerFrame: first.decorationsPerFrame,
      ...(first.sagittalCopyBytes
        ? {
            sagittalCopyBytes: first.sagittalCopyBytes,
            sagittalCopyBuildMs: first.sagittalCopyBuildMs,
          }
        : {}),
    };
  });
}

export function printSummary(r) {
  if (r.build) {
    console.log(
      `\nvolume ${r.build.dims.join('x')} int16 = ${f(r.build.bytes / 2 ** 20, 1)} MiB; alloc ${f(r.build.allocMs, 1)} ms, phantom fill ${f(r.build.fillMs, 0)} ms`,
    );
  }
  table(
    'CPU reslice (ms per plane)',
    [...(r.cpu ?? []), ...(r.workers ?? [])],
    [
      ['method', (x) => x.method],
      ['plane', (x) => x.kind],
      ['interp', (x) => x.interpolation ?? '-'],
      ['size', (x) => x.size],
      ['path', (x) => x.path ?? '-'],
      ['median', (x) => f(x.median)],
      ['p95', (x) => f(x.p95)],
      ['min', (x) => f(x.min)],
      ['max', (x) => f(x.max)],
    ],
  );
  const copy = (r.cpu ?? []).find((x) => x.copyBytes);
  if (copy) {
    console.log(
      `sagittal-major copy: ${f(copy.copyBytes / 2 ** 20, 0)} MiB, built in ${f(copy.copyMs, 0)} ms`,
    );
  }
  for (const [fmt, g] of Object.entries(r.gl ?? {})) {
    console.log(
      `\nWebGL2 ${fmt}: upload ${f(g.upload.ms, 0)} ms, ${f(g.upload.gpuBytes / 2 ** 20, 0)} MiB texture, staging ${f(g.upload.stagingBytes / 2 ** 20, 1)} MiB, SAB view accepted: ${g.upload.sharedViewAccepted}, error: ${g.upload.error}`,
    );
    table(`WebGL2 ${fmt} reslice (ms, SwiftShader)`, g.rows, [
      ['plane', (x) => x.kind],
      ['size', (x) => x.size],
      ['submit', (x) => f(x.submit.median, 3)],
      ['draw+finish', (x) => f(x.drawFinish.median)],
      ['draw+readPixels', (x) => f(x.drawReadPixels.median)],
      ['readPixels only', (x) => f(x.readPixelsOnly?.median)],
      ['draw+drawImage', (x) => f(x.drawImageToCanvas.median)],
      ['maxGreyDiff', (x) => x.maxGreyDiffVsCpu],
      ['frac>1', (x) => f(x.fractionDiffOver1, 4)],
    ]);
  }
  if (r.labels) {
    const L = r.labels;
    table(
      `Label maps (ms; paint = per stamp, ${L.reps} warm reps / ${L.coldTrials} cold trials)`,
      L.rows,
      [
        ['op', (x) => x.op],
        ['state', (x) => x.state ?? '-'],
        ['plane', (x) => x.kind],
        ['algorithm', (x) => x.algorithm ?? '-'],
        ['repr', (x) => x.representation],
        ['n', (x) => x.n],
        ['median', (x) => f(x.median, 3)],
        ['p95', (x) => f(x.p95, 3)],
      ],
    );
    console.log(
      `label memory: dense ${f(L.memory.denseBytes / 2 ** 20, 1)} MiB (pre-touch ${f(L.pretouchMs, 0)} ms), slice masks ${f(L.memory.sliceMaskBytesSpan / 2 ** 20, 2)} MiB in ${L.memory.sliceMasksAllocated} masks, bricked ${f((L.memory.brickedBytes ?? NaN) / 2 ** 20, 2)} MiB in ${L.memory.bricksAllocated ?? '-'} of ${L.memory.brickSlots ?? '-'} bricks; painted ${L.paintedVoxels} voxels, representation mismatches ${L.voxelMismatches}, brick mismatches ${L.brickMismatches ?? '-'}, algorithm mismatches ${L.algorithmMismatches}`,
    );
  }
  for (const m of r.mpr ?? []) {
    const loopCols = [
      ['scenario', (x) => x.scenario],
      ['method', (x) => x.method],
      ['deco', (x) => x.decorationMode ?? 'all'],
      ['ann', (x) => x.annotations ?? '-'],
      ['fps(rAF)', (x) => f(x.fps, 1)],
      ['frame p95', (x) => f(x.frameMs.p95)],
      ['update med', (x) => f(x.updateMs.median)],
      ['update p95', (x) => f(x.updateMs.p95)],
      ['render', (x) => f(x.phases.render?.median)],
      ['reslice', (x) => f(x.phases.reslice.median)],
      ['upload', (x) => f(x.phases.upload.median)],
      ['osdDraw', (x) => f(x.phases.osdDraw.median)],
      ['fabric', (x) => f(x.phases.fabric.median)],
      ['decor', (x) => f(x.phases.decorations.median)],
      ['decor p95', (x) => f(x.phases.decorations.p95)],
      ['providers', (x) => f(x.phases.decoProviders?.median)],
      ['layer', (x) => f(x.phases.decoLayer?.median)],
      ['renderAll', (x) => f(x.phases.decoRenderAll?.median)],
      ['#decor', (x) => x.decorationsPerFrame],
    ];
    const aggCols = [
      ['scenario', (x) => x.scenario],
      ['method', (x) => x.method],
      ['deco', (x) => x.decorationMode],
      ['ann', (x) => x.annotations],
      ['n', (x) => x.reps],
      ['fps med', (x) => f(x.fpsMedian, 1)],
      ['fps range', (x) => `${f(x.fpsMin, 1)}-${f(x.fpsMax, 1)}`],
      ['frame p95', (x) => f(x.frameP95, 1)],
      ['update med', (x) => f(x.updateMedian)],
      ['update p95', (x) => f(x.updateP95)],
      ['reslice', (x) => f(x.phases.reslice.median)],
      ['upload', (x) => f(x.phases.upload.median)],
      ['osdDraw', (x) => f(x.phases.osdDraw.median)],
      ['fabric', (x) => f(x.phases.fabric.median)],
      ['decor', (x) => f(x.phases.decorations.median)],
      ['decor p95', (x) => f(x.phases.decorations.p95)],
      ['providers', (x) => f(x.phases.decoProviders.median)],
      ['layer', (x) => f(x.phases.decoLayer.median)],
      ['renderAll', (x) => f(x.phases.decoRenderAll.median)],
      ['#decor', (x) => x.decorationsPerFrame],
    ];
    const loopSummary = m.loopSummary ?? aggregateLoops(m.loops);
    const sweepSummary = m.sweepSummary ?? aggregateLoops(m.sweep);
    if (loopSummary.some((x) => x.reps > 1) || sweepSummary.some((x) => x.reps > 1)) {
      table(`MPR frame loop, drawer=${m.drawer} (medians over reps; ms)`, loopSummary, aggCols);
      table(
        `MPR annotation-count sweep, drawer=${m.drawer} (medians over reps; ms)`,
        sweepSummary,
        aggCols,
      );
    } else {
      table(`MPR frame loop, drawer=${m.drawer} (ms)`, m.loops, loopCols);
      table(`MPR annotation-count sweep, drawer=${m.drawer} (ms)`, m.sweep, loopCols);
    }
    const copyRow = loopSummary.find((x) => x.sagittalCopyBytes);
    if (copyRow) {
      console.log(
        `sagittal-major copy: ${f(copyRow.sagittalCopyBytes / 2 ** 20, 0)} MiB, built in ${f(copyRow.sagittalCopyBuildMs, 0)} ms`,
      );
    }
    if (m.crossView) {
      console.log(`cross-view check: ${m.crossView.passed} passed, ${m.crossView.failed} failed`);
      for (const c of m.crossView.checks)
        console.log(
          `  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' ' + JSON.stringify(c.detail)}`,
        );
    }
    if (m.contexts) console.log('contexts:', JSON.stringify(m.contexts));
    if (m.glMemory) console.log('GL allocations (bytes):', JSON.stringify(m.glMemory.byFormat));
  }
  if (r.solid) {
    const S = r.solid;
    console.log(`\n## Stock Solid ViewerCells: ${S.passed} passed, ${S.failed} failed`);
    for (const c of S.checks) {
      console.log(
        `  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' ' + JSON.stringify(c.detail)}`,
      );
    }
    const sc = S.scroll;
    console.log(
      `scroll: ${f(sc.fps, 1)} fps, frame median ${f(sc.frameMs.median)} ms, setImageSource (Solid effects) ${f(sc.setImageSourceSyncMs.median)} ms, reslice+redraw ${f(sc.resliceAndRedrawMs.median)} ms, provider runs/frame ${f(sc.providerRunsPerFrame, 1)}; contexts ${JSON.stringify(S.contexts)}`,
    );
  }
  if (r.solidDrawers) {
    table('Stock Solid ViewerCells by OSD drawer and cell count (scroll cell 0)', r.solidDrawers, [
      ['drawer', (x) => x.osdDrawer],
      ['cells', (x) => x.cells],
      ['fps', (x) => f(x.fps, 1)],
      ['frame med', (x) => f(x.frameMs?.median, 1)],
      ['frame p95', (x) => f(x.frameMs?.p95, 1)],
      ['redraw med', (x) => f(x.resliceAndRedrawMs?.median)],
      ['Solid sync', (x) => f(x.setImageSourceSyncMs?.median)],
      ['ctx created', (x) => x.contexts?.created ?? '-'],
      ['ctx live', (x) => x.contexts?.live ?? '-'],
      ['ctx lost', (x) => x.contexts?.lost ?? '-'],
      ['errors', (x) => (x.error ? x.error.slice(0, 60) : (x.pageErrors ?? []).length)],
    ]);
  }
  if (r.niivue) {
    const n = r.niivue;
    console.log('\n## Niivue 3D cell');
    console.log('setup:', JSON.stringify(n.setup.niivue));
    console.log(
      'contexts:',
      JSON.stringify(n.setup.contexts),
      'final:',
      JSON.stringify(n.contexts),
    );
    console.log(
      `rotate: ${f(n.rotate.fps, 2)} fps (SwiftShader), frame median ${f(n.rotate.frameMs.median)} ms; overlay re-projection ${f(n.rotate.reprojectMs.median, 3)} ms for ${n.setup.overlay3D.vertices} vertices`,
    );
    console.log('shared labels:', JSON.stringify(n.labels));
    const mib = (b) => f(b / 2 ** 20, 0);
    const gm = (s) =>
      s
        ? `${mib(s.liveBytes)} MiB live (${Object.entries(s.byFormat)
            .map(([k, v]) => `${k} ${mib(v)}`)
            .join(', ')})`
        : '-';
    console.log(`GL allocations after volume: ${gm(n.setup.glMemoryAfterVolume)}`);
    console.log(`GL allocations after drawing: ${gm(n.labels.glMemoryAfterDrawing)}`);
    if (n.composed) {
      console.log(
        `GL allocations + shared ${n.composed.format} reslicer: ${gm(n.composed.glMemoryAfter)}; contexts ${JSON.stringify(n.composed.contexts)}`,
      );
    }
    console.log(
      'overlay accuracy (px):',
      n.accuracy.results.map((x) => `az ${x.azimuth}: ${f(x.errorPx, 2)}`).join(', '),
    );
  }
  if (r.bundle) {
    table(
      'Bundle size (production, minified)',
      Object.entries(r.bundle).map(([k, v]) => ({ k, ...v })),
      [
        ['entry', (x) => x.k],
        ['min KiB', (x) => f(x.minifiedBytes / 1024, 0)],
        ['gzip KiB', (x) => f(x.gzipBytes / 1024, 0)],
        ['error', (x) => x.error ?? ''],
      ],
    );
  }
  table('Process memory (MiB PSS)', r.memory, [
    ['label', (x) => x.label],
    ['renderer', (x) => f(x.byType?.renderer?.pssMiB, 0)],
    ['gpu-process', (x) => f(x.byType?.['gpu-process']?.pssMiB, 0)],
    ['browser', (x) => f(x.byType?.browser?.pssMiB, 0)],
  ]);
}

// `node scripts/summary.mjs <results.json>` reprints a saved run.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fs = await import('node:fs');
  printSummary(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
}
