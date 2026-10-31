/**
 * Part of the rectangle suite. Pins that a rotated rectangle survives the dev
 * app's Export JSON → Import JSON round trip unchanged: the imported
 * geometry is the exported one exactly, and it is repainted pixel for pixel
 * where it was, which is where its stored geometry says. The pixel comparison
 * is exact, so it first checks that the view has not moved in between.
 */
import { test, expect } from '../helpers/fixtures.js';
import {
  angleBetween,
  bodyPoint,
  deselect,
  drawRectangle,
  expectPaintedAs,
  imageToCanvas,
  imageToPage,
  importAnnotations,
  openAnnotator,
  paintedBounds,
  readAnnotations,
  readOnlyRectangle,
  readView,
  rectanglePoint,
  referenceCentre,
  rgbaAt,
  rotateWithHandle,
  selectAt,
  type Point,
} from './helpers.js';

test.describe('Rectangle suite: export and import', () => {
  test('a rotated rectangle comes back with the same geometry and the same pixels', async ({
    page,
  }) => {
    const view = await openAnnotator(page, { imageScale: 1.37 });
    const drawn = await drawRectangle(page, view, { x: 480.3, y: 290.6 }, { x: 690.8, y: 420.1 });
    await selectAt(page, bodyPoint(view, drawn.geometry), drawn.id);
    const saved = await rotateWithHandle(
      page,
      imageToPage(view, referenceCentre(drawn.geometry)),
      35,
    );
    expect(Math.abs(angleBetween(saved.geometry.rotation, 35))).toBeLessThanOrEqual(1);
    await deselect(page);
    await expectPaintedAs(page, saved.geometry, 'before export');

    // Probes: a 13×13 grid over the painted box, plus points straddling each
    // corner and edge of the rectangle's own frame.
    const box = await paintedBounds(page);
    expect(box, 'nothing painted before export').not.toBeNull();
    const probes: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        probes.push({
          x: box!.minX - 3 + ((box!.maxX - box!.minX + 6) * i) / 12,
          y: box!.minY - 3 + ((box!.maxY - box!.minY + 6) * j) / 12,
        });
      }
    }
    const g = saved.geometry;
    for (const fx of [-0.52, -0.49, 0, 0.49, 0.52]) {
      for (const fy of [-0.52, -0.49, 0, 0.49, 0.52]) {
        probes.push(imageToCanvas(view, rectanglePoint(g, { x: fx * g.width, y: fy * g.height })));
      }
    }
    const viewBefore = await readView(page);
    const pixelsBefore = await rgbaAt(page, probes);
    // The premise: the probes see both the rectangle and empty canvas.
    expect(pixelsBefore.some((p) => p[3]! > 0)).toBe(true);
    expect(pixelsBefore.some((p) => p[3] === 0)).toBe(true);

    await page.getByRole('button', { name: 'Export JSON' }).click();
    const exportPanel = page.locator('textarea');
    await expect(exportPanel).toHaveCount(1);
    const exported = await exportPanel.inputValue();
    const annotations = JSON.parse(exported) as { id: string; geometry: unknown }[];
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.id).toBe(saved.id);
    expect(annotations[0]!.geometry).toEqual(g);
    // Close the panel, which would otherwise sit over part of the cell.
    await page.getByRole('button', { name: 'X', exact: true }).click();
    await expect(exportPanel).toHaveCount(0);

    // Delete it, so whatever is painted next comes from the import alone.
    await selectAt(page, bodyPoint(view, g), saved.id);
    await page.keyboard.press('Delete');
    await expect.poll(() => readAnnotations(page)).toEqual([]);
    await deselect(page);
    expect(await paintedBounds(page)).toBeNull();

    await importAnnotations(page, exported);

    const loaded = await readOnlyRectangle(page);
    expect(loaded.id).toBe(saved.id);
    expect(loaded.geometry).toEqual(g);
    // The probes are canvas pixels, so they compare only under the same view:
    // a layout shift or a pan would fail below as a pixel diff, unexplained.
    const viewAfter = await readView(page);
    expect(viewAfter.canvasOrigin, 'the canvas moved on the page since export').toEqual(
      viewBefore.canvasOrigin,
    );
    expect(viewAfter.canvasSize, 'the canvas was resized since export').toEqual(
      viewBefore.canvasSize,
    );
    viewAfter.vpt.forEach((v, k) => {
      expect(
        Math.abs(v - viewBefore.vpt[k]!),
        `the view was panned or zoomed since export: viewportTransform ${JSON.stringify(viewAfter.vpt)}, was ${JSON.stringify(viewBefore.vpt)}`,
      ).toBeLessThan(1e-9);
    });
    expect(await rgbaAt(page, probes)).toEqual(pixelsBefore);
    await expectPaintedAs(page, loaded.geometry, 'after import');
  });
});
