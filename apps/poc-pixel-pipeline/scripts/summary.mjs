/** Console summary of a results object (see run.mjs). */
const f = (n, d = 1) => (typeof n === 'number' ? n.toFixed(d) : String(n));

function table(title, header, rows) {
  console.log(`\n${title}`);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

export function printSummary(r) {
  if (r.h1Analytic) {
    const a = r.h1Analytic.phantom;
    table(
      'H1 analytic (data range -1000..3000 HU): distinct grey levels in window / largest band step (grey levels) / widest band (HU)',
      [
        'window',
        'correct 16-bit',
        'best possible 8-bit',
        'CSS unbounded',
        'CSS osdlabel [0,2]',
        'slope needed/osdlabel max',
      ],
      Object.entries(a).map(([w, c]) => [
        w,
        `${c.correct.distinctLevels} / ${c.correct.maxStep} / ${c.correct.maxBandWidth}`,
        `${c.best8bit.distinctLevels} / ${c.best8bit.maxStep} / ${c.best8bit.maxBandWidth}`,
        `${c.unboundedCss.distinctLevels} / ${c.unboundedCss.maxStep} / ${c.unboundedCss.maxBandWidth}${c.unboundedCssParams.exact ? '' : ' (inexact)'}`,
        `${c.osdlabelCss.distinctLevels} / ${c.osdlabelCss.maxStep} / err ${f(c.osdlabelCss.maxAbsError, 0)}`,
        `${f(c.osdlabelCssParams.requiredSlope)} / ${f(c.osdlabelCssParams.achievedSlope)}`,
      ]),
    );
  }
  if (r.h1Browser) {
    table(
      'H1 in Chromium (screenshot of the value ramp): distinct levels / max step / mismatches vs model',
      ['window', 'gpu (VOI drawer)', 'cpu (canvas drawer)', 'css-osdlabel', 'css-unbounded'],
      Object.entries(r.h1Browser).map(([w, p]) => [
        w,
        ...['gpu', 'cpu', 'css-osdlabel', 'css-unbounded'].map(
          (k) => `${p[k].stats.distinctLevels} / ${p[k].stats.maxStep} / ${p[k].modelMismatch}`,
        ),
      ]),
    );
  }
  if (r.h2) {
    table(
      'H2 whole-image CPU re-window per W/L step (ms, median; p95)',
      ['image', 'impl', 'Mpx', 'lut', 'apply', 'putImageData', 'display', 'total', 'fps-equiv'],
      r.h2.full.map((x) => [
        x.image,
        x.impl,
        f(x.pixels / 1e6, 2),
        f(x.lut.median, 2),
        f(x.apply.median),
        f(x.putImageData.median),
        f(x.displayDrawImage.median),
        `${f(x.total.median)}; ${f(x.total.p95)}`,
        f(1000 / x.total.median),
      ]),
    );
    table(
      'H2 worker pool, mammogram (ms, median)',
      ['workers', 'wall', 'main blocked', 'slowest worker', 'SAB copy'],
      r.h2.workers.map((x) => [
        x.workers,
        f(x.wall.median),
        f(x.mainThreadBlocked.median),
        f(x.slowestWorker.median),
        f(x.sabCopy.median),
      ]),
    );
    table(
      'H2 tiled CPU path inside OSD (1024x1024 viewer): per W/L step',
      [
        'image',
        'zoom',
        'drawer',
        'W/L visible w/o private API',
        'tiles',
        'Mpx',
        'draw complete ms (med; p95)',
        'rAF fps',
      ],
      r.h2.osd.map((x) => [
        x.image,
        x.zoom,
        x.drawerType,
        x.wlReachesScreenWithoutPrivateApi,
        f(x.tilesPerStep.median, 0),
        f(x.pixelsPerStep.median / 1e6, 2),
        `${f(x.drawComplete.median)}; ${f(x.drawComplete.p95)}`,
        f(x.raf.fps),
      ]),
    );
  }
  if (r.h2?.scaling || r.h3?.scaling) {
    const rows = [];
    for (const x of r.h2?.scaling ?? [])
      rows.push([
        'CPU tiles (canvas drawer)',
        x.viewport,
        f(x.pixelsPerStep.median / 1e6, 2),
        `${f(x.drawComplete.median)}; ${f(x.drawComplete.p95)}`,
        f(x.raf.fps),
      ]);
    for (const x of r.h3?.scaling ?? [])
      rows.push([
        'GPU r16i (VOI drawer, SwiftShader)',
        x.viewport,
        '-',
        `${f(x.drawComplete.median)}; ${f(x.drawComplete.p95)}`,
        f(x.raf.fps),
      ]);
    table(
      'H2/H3 scaling, mammogram at 1:1, by drawn area',
      ['path', 'viewer', 'Mpx re-windowed/step', 'ms/step (med; p95)', 'rAF fps'],
      rows,
    );
  }
  if (r.h3) {
    table(
      'H3 texture upload (per tile, incl. GPU drain)',
      ['format', 'tile', 'ms/tile', 'MB/s (16-bit eq.)', 'B/tile'],
      r.h3.upload.map((x) => [
        x.format,
        x.tileSize,
        f(x.msPerTileInclGpu, 3),
        f(x.mbPerSecond, 0),
        x.bytesPerTile,
      ]),
    );
    table(
      'H3 GPU W/L drag inside OSD (1024x1024 viewer)',
      [
        'image',
        'zoom',
        'format',
        'target',
        'tiles/frame',
        'uploads during drag',
        'draw JS ms',
        'draw+GPU ms (med; p95)',
        'rAF fps',
        'tex MB',
      ],
      r.h3.osd.map((x) => [
        x.image,
        x.zoom,
        x.format,
        x.target,
        f(x.tilesPerFrame, 0),
        x.uploadsDuringDrag,
        f(x.drawSync.median, 2),
        `${f(x.drawComplete.median)}; ${f(x.drawComplete.p95)}`,
        f(x.raf.fps),
        f(x.liveTextureMB, 1),
      ]),
    );
    table(
      'H3 VOI drawer vs a stock OSD drawer fed CPU-windowed tiles (CT, 512x512, zoom 1.37, worst of 4 windows)',
      [
        'reference',
        'rotation',
        'flip',
        'smoothing',
        'format',
        'differing px',
        '>2 levels',
        '>2 not a 1px shift',
        'max diff',
      ],
      r.h3.equivalence.map((x) => {
        const worst = x.perWindow.reduce((a, b) =>
          b.differingFraction > a.differingFraction ? b : a,
        );
        return [
          x.reference,
          x.rotation,
          x.flip,
          x.smoothing,
          x.format,
          `${f(worst.differingFraction * 100, 2)}%`,
          `${f(worst.over2Fraction * 100, 2)}%`,
          `${f(worst.over2NotExplainedBy1pxShift * 100, 3)}%`,
          worst.maxDiff,
        ];
      }),
    );
    if (r.h3.alignment) {
      table(
        'H3 registration: FabricOverlay.imageToScreen vs VOI drawer output',
        ['rotation', 'flippedH', 'matched'],
        r.h3.alignment.cases.map((c) => [c.rotation, c.flippedH, `${c.matched}/${c.total}`]),
      );
    }
  }
  if (r.h4) {
    for (const [name, rows] of Object.entries(r.h4.sweeps ?? {})) {
      table(
        `H4 ${name}: N cells -> contexts and visibility after a redraw`,
        [
          'N',
          'drawer',
          'webgl ctx created',
          'live',
          'lost',
          'blank cells',
          'pan fps',
          'draw() ms/frame (all cells)',
        ],
        rows.map((x) => [
          x.n,
          x.drawerTypes.join('/'),
          x.contexts.created,
          x.contexts.live,
          x.contexts.lost,
          x.blankCells,
          x.pan ? f(x.pan.fps) : '-',
          x.pan ? f(x.pan.drawSumPerFrameMs, 2) : '-',
        ]),
      );
    }
    if (r.h4.recovery) {
      table(
        'H4 eviction and recovery (17 cells, then 16 destroyed)',
        [
          'mode',
          'cell 0 visible @17',
          'cell 0 updates while panned',
          'healthy cell updates',
          'cell 0 visible after freeing',
          'restored events',
        ],
        Object.entries(r.h4.recovery).map(([m, x]) => [
          m,
          x.cell0VisibleWith17,
          x.cell0UpdateViewportEventsDuringPan,
          x.healthyCellUpdateViewportEventsDuringPan,
          x.cell0VisibleAfterFreeing,
          x.contextsFinal?.restoredEvents,
        ]),
      );
    }
    if (r.h4.foreign) {
      table(
        'H4 one foreign WebGL context next to 16 cells',
        ['mode', 'blank before', 'blank after', 'live contexts'],
        Object.entries(r.h4.foreign).map(([m, x]) => [
          m,
          x.blankBefore,
          x.blankAfter,
          x.contexts.live,
        ]),
      );
    }
    if (r.h4.swap) {
      table(
        'H4 mitigation (i): cells 1-15 of 16 swapped to the CanvasDrawer at runtime',
        [
          'via',
          'swap ms (med)',
          'canvas above overlay',
          'canvas displaced',
          'tone filter kept',
          'blank after',
          'live ctx',
          'back to webgl ms',
        ],
        Object.entries(r.h4.swap).map(([v, x]) => [
          v,
          f(x.swapMs.median),
          `${x.drawerCanvasAboveOverlay}/${x.swapped}`,
          `${x.drawerCanvasDisplaced}/${x.swapped}`,
          `${x.filterKept}/${x.swapped}`,
          x.blankAfterSwap.length,
          x.contexts.live,
          x.backToWebgl ? f(x.backToWebgl.swapMs.median) : '-',
        ]),
      );
    }
    if (r.h4.errors) console.log('\nH4 errors:', JSON.stringify(r.h4.errors));
  }
  if (r.devApp) {
    const d = r.devApp;
    table(
      'osdlabel Solid dev app (apps/dev), 4x4 grid',
      [
        'cells',
        'ctx created (1 cell)',
        'ctx created / live (16 cells)',
        'visible before',
        'visible after 1 foreign ctx',
        'blank',
      ],
      [
        [
          d.cellsAssigned,
          d.contextsWithOneCell?.created,
          `${d.contextsWith16Cells?.created} / ${d.contextsWith16Cells?.live}`,
          d.visibleCellsBefore,
          d.visibleCellsAfterForeign,
          JSON.stringify(d.blankIndicesAfterForeign),
        ],
      ],
    );
  }
}
