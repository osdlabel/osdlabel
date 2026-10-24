/**
 * H2 end-to-end: draw with the real osdlabel tools in one cell, then read what
 * every other cell shows. Mouse input goes through Playwright, so the path is
 * OSD MouseTracker -> FabricOverlay -> tool -> annotation store -> providers
 * -> DecorationLayer, with no shortcut.
 *
 * Expected values are derived from the volume grid by hand (see comments),
 * not from @osdlabel/spatial, so the check is independent of the math under
 * test.
 */
export async function crossViewCheck(page, call, dims) {
  const { nx, ny, nz } = dims;
  const sz = 1.25;
  const s = 0.7;
  const kAx = Math.floor(nz / 2); // axial cell's slice
  const jCor = Math.floor(ny / 2); // coronal cell's row
  const iSag = Math.floor(nx / 2); // sagittal cell's column
  // Coronal / sagittal image row of axial slice k: corner at k = nz - 0.5,
  // rows step 0.7 mm towards inferior, slices are 1.25 mm apart.
  const rowOfK = (k) => ((nz - 0.5 - k) * sz) / s;

  const drag = async (cell, a, b) => {
    const g = await call(page, 'cellGeometry', cell, [a, b]);
    const [p, q] = g.points;
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
    await page.mouse.move(q.x, q.y, { steps: 4 });
    await page.mouse.up();
  };
  const click = async (cell, a) => {
    const g = await call(page, 'cellGeometry', cell, [a]);
    const [p] = g.points;
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
  };

  // 1. Rectangle on the axial view.
  const r1 = { x: 0.3 * nx, y: 0.3 * ny };
  const r2 = { x: 0.6 * nx, y: 0.55 * ny };
  await call(page, 'activateTool', 'axial', 'rectangle');
  await drag('axial', r1, r2);
  // 2. Point on the coronal view, placed where the axial plane crosses it.
  const iPt = Math.round(0.45 * nx);
  await call(page, 'activateTool', 'coronal', 'point');
  await click('coronal', { x: iPt + 0.5, y: rowOfK(kAx) });
  await call(page, 'deactivateTool');
  await page.waitForTimeout(100);

  const anns = await call(page, 'annotations');
  const rect = [...anns].reverse().find((a) => a.type === 'rectangle');
  const point = [...anns].reverse().find((a) => a.type === 'point');
  const seen = await call(page, 'inspect');
  const find = (cell, id) => seen[cell].decorations.filter((d) => d.id.startsWith(`xv:${id}:`));

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check('rectangle committed by RectangleTool', rect, rect?.geometry);
  check('point committed by PointTool', point, point?.geometry);
  if (rect) {
    // RectangleGeometry is { origin, width, height, rotation } (rotation 0 here).
    const g0 = rect.geometry;
    const geom = { x: g0.origin.x, y: g0.origin.y, width: g0.width, height: g0.height };
    for (const cell of ['coronal', 'sagittal']) {
      const segs = find(cell, rect.id);
      const seg = segs[0];
      const expectedRow = rowOfK(kAx);
      // Coronal x is i, sagittal x is j, and both cells put voxel centres at
      // the same pixel-centre offsets as the axial view, so the segment's ends
      // are the committed rectangle's edges along that axis, unmirrored and
      // unshifted (a flipped or offset axis fails this, a span check did not).
      const [lo, hi] =
        cell === 'coronal' ? [geom.x, geom.x + geom.width] : [geom.y, geom.y + geom.height];
      const x0 = seg ? seg.start.x : NaN;
      const x1 = seg ? seg.end.x : NaN;
      check(
        `axial rectangle shows as one segment in ${cell}, at its row and edges`,
        segs.length === 1 &&
          seg.type === 'line' &&
          Math.abs(seg.start.y - expectedRow) < 0.01 &&
          Math.abs(seg.end.y - expectedRow) < 0.01 &&
          Math.abs(Math.min(x0, x1) - lo) < 0.01 &&
          Math.abs(Math.max(x0, x1) - hi) < 0.01,
        { segs, expectedRow, expectedX: [lo, hi] },
      );
    }
    // The drag landed where it was aimed (tool + screen->image mapping).
    check(
      'committed rectangle matches the drag targets within 1 px',
      Math.abs(geom.x - r1.x) < 1 &&
        Math.abs(geom.y - r1.y) < 1 &&
        Math.abs(geom.x + geom.width - r2.x) < 1 &&
        Math.abs(geom.y + geom.height - r2.y) < 1,
      { geom: g0, r1, r2 },
    );
    // Oblique cell: map the segment's ends to patient space with the cell's
    // own frame (origin = centre of pixel (0,0)) and check, with plain
    // arithmetic, that they lie in the axial plane and on the rectangle's
    // boundary, and that the midpoint is inside it.
    const obl = find('oblique', rect.id);
    const f = seen.oblique.frame;
    const toPatient = (p) =>
      [0, 1, 2].map(
        (a) =>
          f.origin[a] +
          (p.x - 0.5) * f.pixelSpacing.x * f.rowDirection[a] +
          (p.y - 0.5) * f.pixelSpacing.y * f.columnDirection[a],
      );
    const gridOrigin = [(-(nx - 1) * s) / 2, (-(ny - 1) * s) / 2, (-(nz - 1) * sz) / 2];
    const zAxial = gridOrigin[2] + kAx * sz;
    const toAxial = (P) => ({
      x: (P[0] - gridOrigin[0]) / s + 0.5,
      y: (P[1] - gridOrigin[1]) / s + 0.5,
    });
    // Distance to the rectangle's boundary (its four edge SEGMENTS, so a point
    // on an edge's extension line does not pass).
    const onEdge = (q) => {
      const x0 = geom.x;
      const x1 = geom.x + geom.width;
      const y0 = geom.y;
      const y1 = geom.y + geom.height;
      const cx = Math.min(Math.max(q.x, x0), x1);
      const cy = Math.min(Math.max(q.y, y0), y1);
      return Math.min(
        Math.hypot(q.x - x0, q.y - cy),
        Math.hypot(q.x - x1, q.y - cy),
        Math.hypot(q.x - cx, q.y - y0),
        Math.hypot(q.x - cx, q.y - y1),
      );
    };
    const ends = obl[0]?.type === 'line' ? [obl[0].start, obl[0].end].map(toPatient) : [];
    const mid = ends.length === 2 ? ends[0].map((v, a) => (v + ends[1][a]) / 2) : null;
    const endInfo = ends.map((P) => ({
      dz: P[2] - zAxial,
      axial: toAxial(P),
      edgeDist: onEdge(toAxial(P)),
    }));
    const midAx = mid ? toAxial(mid) : null;
    check(
      'axial rectangle shows in the oblique cell as one segment in the axial plane, ending on the rectangle',
      obl.length === 1 &&
        endInfo.length === 2 &&
        endInfo.every((e) => Math.abs(e.dz) < 0.01 && e.edgeDist < 0.01) &&
        midAx.x > geom.x &&
        midAx.x < geom.x + geom.width &&
        midAx.y > geom.y &&
        midAx.y < geom.y + geom.height,
      { segs: obl, endInfo, midAxial: midAx },
    );
    check(
      'axial rectangle is a native Fabric object in axial',
      seen.axial.native >= 1 && find('axial', rect.id).length === 0,
      { native: seen.axial.native },
    );
  }
  if (point) {
    const m = find('axial', point.id);
    const expected = { x: iPt + 0.5, y: jCor + 0.5 };
    const at = m[0]?.anchor;
    const err = at ? Math.hypot(at.x - expected.x, at.y - expected.y) : NaN;
    check(
      'coronal point shows as a marker in axial (within half a slice)',
      m.length === 1 && m[0].type === 'text' && err < 1.5,
      {
        anchor: at,
        expected,
        errorPx: err,
      },
    );
    check(
      'coronal point is absent from sagittal (26 voxels away)',
      find('sagittal', point.id).length === 0,
      {
        iPoint: iPt,
        iSagittal: iSag,
      },
    );
    // DOM placement: the marker element sits where the overlay projects the anchor.
    const screen = m[0]?.screen;
    const dom = seen.axial.markerElements;
    const nearest = screen
      ? Math.min(...dom.map((d) => Math.hypot(d.x - screen.x, d.y - screen.y)))
      : NaN;
    check('marker DOM element is placed at imageToScreen(anchor)', nearest < 1.5, {
      screen,
      nearestDomPx: nearest,
    });
  }
  const refLines = Object.fromEntries(
    Object.entries(seen).map(([k, v]) => [
      k,
      v.decorations.filter((d) => d.id.startsWith('ref:')).length,
    ]),
  );
  check(
    'every cell draws reference lines for the other three planes',
    Object.values(refLines).every((n) => n === 3),
    refLines,
  );

  // 3. Scroll the axial view one slice: the rectangle stops being native there,
  //    and a parallel plane 1.25 mm away (> half a slice) must not show it.
  await call(page, 'setSlice', 'axial', kAx + 1);
  await page.waitForTimeout(200);
  const after = await call(page, 'inspect');
  check(
    'after scrolling one slice the rectangle leaves the axial view',
    rect &&
      after.axial.decorations.every((d) => !d.id.startsWith(`xv:${rect.id}:`)) &&
      after.axial.native < seen.axial.native,
    { nativeBefore: seen.axial.native, nativeAfter: after.axial.native },
  );
  await call(page, 'setSlice', 'axial', kAx);
  await page.waitForTimeout(200);

  return {
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
    checks,
    decorationCounts: Object.fromEntries(
      Object.entries(seen).map(([k, v]) => [k, v.decorations.length]),
    ),
  };
}
