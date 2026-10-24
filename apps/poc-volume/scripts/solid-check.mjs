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
  const axialId = `vol:axial:${kAx}`;
  const coronalId = `vol:coronal:${jCor}`;
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
