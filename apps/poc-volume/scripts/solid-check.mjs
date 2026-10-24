/* global window -- referenced inside page.waitForFunction, which runs in the browser */
/**
 * Stock @osdlabel/solid ViewerCells over volume planes (solid.html): draw
 * with the binding's own tool wiring, check the other cells' projections,
 * then time slice scrolling through the binding's reactive path.
 */
export async function solidCheck(page, call, dims, frames) {
  const { nx, ny, nz } = dims;
  const rowOfK = (k) => ((nz - 0.5 - k) * 1.25) / 0.7;
  const kAx = Math.floor(nz / 2);
  const jCor = Math.floor(ny / 2);
  await page.waitForFunction(() => window.__poc.ready(), null, { timeout: 60000 });
  await call(page, 'paintAll');
  await page.waitForTimeout(300);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  // Rectangle on the axial cell (index 0) through the binding's tool hook.
  await call(page, 'setActiveCell', 0);
  await call(page, 'setTool', 'rectangle');
  await page.waitForTimeout(200);
  const r1 = { x: 0.3 * nx, y: 0.3 * ny };
  const r2 = { x: 0.6 * nx, y: 0.55 * ny };
  const [p, q] = await call(page, 'cellGeometry', 0, [r1, r2]);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
  await page.mouse.move(q.x, q.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  // Point on the coronal cell (index 1), on the axial plane's row.
  await call(page, 'setActiveCell', 1);
  await call(page, 'setTool', 'point');
  await page.waitForTimeout(200);
  const iPt = Math.round(0.45 * nx);
  const [c] = await call(page, 'cellGeometry', 1, [{ x: iPt + 0.5, y: rowOfK(kAx) }]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  await call(page, 'setTool', 'select');
  await page.waitForTimeout(400);

  const store = await call(page, 'store');
  const axialId = await call(page, 'idFor', 'axial', kAx);
  const coronalId = await call(page, 'idFor', 'coronal', jCor);
  check(
    'plane image ids use the reversible orthogonal form',
    axialId === `vol:phantom:axial:${kAx}` && coronalId === `vol:phantom:coronal:${jCor}`,
    { axialId, coronalId },
  );
  check(
    'rectangle stored under the axial plane image id',
    (store[axialId] ?? []).some((a) => a.geometry.type === 'rectangle'),
    Object.keys(store),
  );
  check(
    'point stored under the coronal plane image id',
    (store[coronalId] ?? []).some((a) => a.geometry.type === 'point'),
    Object.keys(store),
  );
  const decoded = await call(page, 'decodeStoredIds');
  check(
    'every stored image id decodes to the grid slice it was drawn on',
    decoded.length >= 2 && decoded.every((d) => d.form === 'orthogonal' && d.matchesGridSlice),
    decoded,
  );
  const seen = await call(page, 'inspect');
  for (const i of [1, 2]) {
    const yellow = seen[i].decorationLines.filter((l) => l.stroke === '#ffd400');
    const hit = yellow.find(
      (l) => Math.abs(l.y1 - rowOfK(kAx)) < 0.01 && Math.abs(l.y2 - rowOfK(kAx)) < 0.01,
    );
    check(`axial rectangle projected into ${seen[i].kind} by the shared provider`, hit, {
      yellow: yellow.length,
      hit,
    });
  }
  check('coronal point projected into axial as a marker', seen[0].markers >= 1, {
    markers: seen[0].markers,
  });
  check(
    'rectangle is a native annotation object in the axial cell',
    seen[0].annotationObjects >= 1,
    {
      annotationObjects: seen[0].annotationObjects,
    },
  );
  const refs = seen.map((s) => s.decorationLines.filter((l) => l.stroke !== '#ffd400').length);
  check(
    'each cell draws reference lines for the two other planes',
    refs.every((n) => n === 2),
    refs,
  );

  const scroll = await call(page, 'scroll', frames);
  await page.waitForTimeout(400);
  const after = await call(page, 'inspect');
  check(
    'after scrolling away and back the rectangle is native again',
    after[0].annotationObjects >= 1,
    {
      annotationObjects: after[0].annotationObjects,
    },
  );
  return {
    passed: checks.filter((x) => x.ok).length,
    failed: checks.filter((x) => !x.ok).length,
    checks,
    scroll,
    contexts: await call(page, 'contexts'),
  };
}

/**
 * The context-budget stopgap: N stock ViewerCells with OSD's default (WebGL)
 * drawer vs OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas'. Records the
 * WebGL contexts created / live / lost and the scroll fps of cell 0 (whose
 * scroll re-runs every cell's providers through Solid's tracking).
 */
export async function solidDrawerMatrix(context, open, call, counts, frames) {
  const rows = [];
  for (const osdDrawer of ['default', 'canvas']) {
    for (const cells of counts) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
      try {
        // Same 256 px cells for every N, so fps compares across N.
        await open(page, 'solid.html', `cells=${cells}&osdDrawer=${osdDrawer}&cellPx=256`);
        await page.waitForFunction(() => window.__poc.ready(), null, { timeout: 120000 });
        await call(page, 'paintAll');
        await page.waitForTimeout(500);
        const afterSetup = await call(page, 'contexts');
        const scroll = await call(page, 'scroll', frames);
        rows.push({
          osdDrawer,
          cells,
          contextsAfterSetup: afterSetup,
          contexts: await call(page, 'contexts'),
          fps: scroll.fps,
          frameMs: scroll.frameMs,
          resliceAndRedrawMs: scroll.resliceAndRedrawMs,
          setImageSourceSyncMs: scroll.setImageSourceSyncMs,
          providerRunsPerFrame: scroll.providerRunsPerFrame,
          glMemory: await call(page, 'glMemory'),
          pageErrors: errors,
        });
      } catch (e) {
        rows.push({ osdDrawer, cells, error: String(e).slice(0, 300), pageErrors: errors });
      } finally {
        await page.close();
      }
    }
  }
  return rows;
}
