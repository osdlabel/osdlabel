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
    table('Label maps (ms)', L.rows, [
      ['op', (x) => x.op],
      ['plane', (x) => x.kind],
      ['repr', (x) => x.representation],
      ['median', (x) => f(x.median, 3)],
      ['p95', (x) => f(x.p95, 3)],
    ]);
    console.log(
      `label memory: dense ${f(L.memory.denseBytes / 2 ** 20, 1)} MiB, slice masks ${f(L.memory.sliceMaskBytes / 2 ** 20, 2)} MiB in ${L.memory.sliceMasksAllocated} masks; painted ${L.paintedVoxels} voxels, mismatches ${L.voxelMismatches}`,
    );
  }
  for (const m of r.mpr ?? []) {
    table(`MPR frame loop, drawer=${m.drawer} (ms)`, m.loops, [
      ['scenario', (x) => x.scenario],
      ['frames', (x) => x.frames],
      ['fps(rAF)', (x) => f(x.fps, 1)],
      ['frame median', (x) => f(x.frameMs.median)],
      ['frame p95', (x) => f(x.frameMs.p95)],
      ['update median', (x) => f(x.updateMs.median)],
      ['reslice', (x) => f(x.phases.reslice.median)],
      ['upload', (x) => f(x.phases.upload.median)],
      ['osdDraw', (x) => f(x.phases.osdDraw.median)],
      ['fabric', (x) => f(x.phases.fabric.median)],
      ['decor', (x) => f(x.phases.decorations.median)],
    ]);
    if (m.crossView) {
      console.log(`cross-view check: ${m.crossView.passed} passed, ${m.crossView.failed} failed`);
      for (const c of m.crossView.checks)
        console.log(
          `  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' ' + JSON.stringify(c.detail)}`,
        );
    }
    if (m.contexts) console.log('contexts:', JSON.stringify(m.contexts));
  }
  if (r.niivue)
    console.log('\nniivue:', JSON.stringify(r.niivue.summary ?? r.niivue, null, 0).slice(0, 2000));
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
