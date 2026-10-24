/**
 * Drives annotate.html like a user: draws on a DICOM WSI, a CT slice and an
 * ultrasound frame in the stock <Annotator>, paints a brush mask, then
 * exports SR / SEG / ANN. Returns the exported files and what was drawn.
 */
import fs from 'node:fs';
import path from 'node:path';

async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function canvasBox(page) {
  const c = page.locator('canvas.upper-canvas').first();
  await c.waitFor({ state: 'attached', timeout: 30000 });
  const box = await c.boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

async function show(page, imageId) {
  await page.getByTestId(`filmstrip-item-${imageId}`).click();
  await page.waitForTimeout(1200);
}

export async function runAnnotateFlow(page, origin, outDir) {
  const t0 = Date.now();
  await page.goto(`${origin}/annotate.html`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
  const images = await page.evaluate(() => window.__annot.images);
  const timings = await page.evaluate(() => window.__annot.timings);
  const wsi = images[0];
  const ct = images.find((i) => (i.label ?? '').startsWith('CT'));
  const us = images.find((i) => (i.label ?? '').startsWith('US'));

  // WSI: a rectangle and a line.
  await show(page, wsi.id);
  let box = await canvasBox(page);
  await page.getByTestId('tool-rectangle').click();
  await drag(
    page,
    { x: box.x + box.width * 0.35, y: box.y + box.height * 0.4 },
    { x: box.x + box.width * 0.5, y: box.y + box.height * 0.55 },
  );
  await page.getByTestId('tool-line').click();
  await drag(
    page,
    { x: box.x + box.width * 0.55, y: box.y + box.height * 0.3 },
    { x: box.x + box.width * 0.7, y: box.y + box.height * 0.45 },
  );

  // CT: a circle and a brush stroke.
  await show(page, ct.id);
  box = await canvasBox(page);
  await page.getByTestId('tool-circle').click();
  await drag(
    page,
    { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 },
    { x: box.x + box.width * 0.52, y: box.y + box.height * 0.52 },
  );
  await page.getByTestId('tool-segmentationBrush').click();
  await drag(
    page,
    { x: box.x + box.width * 0.3, y: box.y + box.height * 0.6 },
    { x: box.x + box.width * 0.4, y: box.y + box.height * 0.62 },
    20,
  );

  // US: a line inside the calibrated region.
  await show(page, us.id);
  box = await canvasBox(page);
  await page.getByTestId('tool-line').click();
  await drag(
    page,
    { x: box.x + box.width * 0.4, y: box.y + box.height * 0.45 },
    { x: box.x + box.width * 0.55, y: box.y + box.height * 0.5 },
  );
  await page.waitForTimeout(500);
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-decoration-id], .osdlabel-decoration, div')]
      .map((e) => e.textContent ?? '')
      .filter((t) => /mm|µm|not measurable/.test(t) && t.length < 80),
  );
  await page.screenshot({ path: path.join(outDir, 'annotate-us.png') });

  const drawn = await page.evaluate(() =>
    window.__annot
      .annotations()
      .map((a) => ({ id: a.id, imageId: a.imageId, type: a.geometry.type, geometry: a.geometry })),
  );
  const exported = await page.evaluate(() => window.__annot.export());
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of exported)
    fs.writeFileSync(path.join(outDir, f.name), Buffer.from(f.base64, 'base64'));
  return {
    ms: Date.now() - t0,
    loadTimings: timings,
    images: images.length,
    drawn: drawn.map((d) => ({ type: d.type, image: d.imageId.slice(-12) })),
    wsiGeometry: drawn.filter((d) => d.imageId === wsi.id).map((d) => d.geometry),
    measurementLabels: [...new Set(labels)].slice(0, 12),
    exported: exported.map((f) => ({
      name: f.name,
      kind: f.kind,
      items: f.items,
      bytes: Buffer.from(f.base64, 'base64').length,
    })),
  };
}
