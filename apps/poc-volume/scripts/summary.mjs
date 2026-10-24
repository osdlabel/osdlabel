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
    ],
  );
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
      `label memory: dense ${f(L.memory.denseBytes / 2 ** 20, 1)} MiB (pre-touch ${f(L.pretouchMs, 0)} ms), slice masks ${f(L.memory.sliceMaskBytesSpan / 2 ** 20, 2)} MiB in ${L.memory.sliceMasksAllocated} masks; painted ${L.paintedVoxels} voxels, representation mismatches ${L.voxelMismatches}, algorithm mismatches ${L.algorithmMismatches}`,
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
    table(`MPR frame loop, drawer=${m.drawer} (ms)`, m.loops, loopCols);
    table(`MPR annotation-count sweep, drawer=${m.drawer} (ms)`, m.sweep, loopCols);
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
