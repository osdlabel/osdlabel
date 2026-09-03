import { test, expect, type Page } from '@playwright/test';

interface StoredAnnotation {
  geometry: { type: string; pixelCount?: number; origin?: { x: number; y: number } };
  toolType?: string;
  rawAnnotationData?: { format?: string };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/** Drags a short stroke across the canvas, sampling a few intermediate points. */
async function stroke(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: 'Alt'[] = [],
): Promise<void> {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
  await page.waitForTimeout(200);
}

test.describe('Segmentation brush', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // The bundled local image loads without network access.
    await page.getByTestId('filmstrip-item-jpg').click();
    // "General" context (index 2) includes the brush.
    await page.selectOption('select', { index: 2 });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  test('painting commits a mask annotation with painted pixels', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.geometry.type).toBe('mask');
    expect(annotations[0]?.toolType).toBe('segmentationBrush');
    expect(annotations[0]?.rawAnnotationData?.format).toBe('osdlabel-mask');
    expect(annotations[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(0);
  });

  test('a second stroke refines the same mask rather than creating another', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 240, y: box.y + 160 });
    const first = await readAnnotations(page);
    expect(first).toHaveLength(1);

    await stroke(page, { x: box.x + 200, y: box.y + 200 }, { x: box.x + 240, y: box.y + 200 });
    const second = await readAnnotations(page);

    // Still one annotation, now covering more pixels.
    expect(second).toHaveLength(1);
    expect(second[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(first[0]?.geometry.pixelCount ?? 0);
  });

  test('Alt-dragging erases from the mask', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 300, y: box.y + 160 });
    const painted = await readAnnotations(page);
    const paintedCount = painted[0]?.geometry.pixelCount ?? 0;
    expect(paintedCount).toBeGreaterThan(0);

    await stroke(page, { x: box.x + 240, y: box.y + 160 }, { x: box.x + 280, y: box.y + 160 }, [
      'Alt',
    ]);

    const erased = await readAnnotations(page);
    expect(erased).toHaveLength(1);
    expect(erased[0]?.geometry.pixelCount ?? 0).toBeLessThan(paintedCount);
  });

  test('painting over an existing shape paints, and does not drag it', async ({ page }) => {
    const box = (await page.locator('canvas.upper-canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Draw a rectangle, then paint straight across it. With the canvas in
    // ordinary annotation mode the stroke grabbed and moved the rectangle, and
    // `object:modified` persisted the move — silent corruption of an
    // annotation the user was not even editing.
    await page.getByTestId('tool-rectangle').click();
    await stroke(page, { x: cx - 120, y: cy - 100 }, { x: cx + 120, y: cy + 100 });

    const rectBefore = (await readAnnotations(page)).find((a) => a.geometry.type === 'rectangle');
    expect(rectBefore).toBeDefined();
    const originBefore = JSON.stringify(rectBefore!.geometry.origin);

    await page.getByTestId('tool-segmentationBrush').click();

    // Two strokes, deliberately. The first commits, which clears and rebuilds
    // the annotation layer — and the rebuild used to hand every object its
    // interactivity back, silently undoing paint mode. A single-stroke test
    // passes against that bug; the second stroke is the one that catches it.
    await stroke(page, { x: cx - 350, y: cy + 220 }, { x: cx - 250, y: cy + 220 });
    expect((await readAnnotations(page)).filter((a) => a.geometry.type === 'mask')).toHaveLength(1);

    await stroke(page, { x: cx - 100, y: cy }, { x: cx + 100, y: cy });

    const after = await readAnnotations(page);
    const rectAfter = after.find((a) => a.geometry.type === 'rectangle');
    expect(JSON.stringify(rectAfter!.geometry.origin)).toBe(originBefore);

    const masks = after.filter((a) => a.geometry.type === 'mask');
    expect(masks[0]!.geometry.pixelCount).toBeGreaterThan(0);
  });

  test('the toolbar exposes brush radius while the brush is active', async ({ page }) => {
    await expect(page.getByTestId('brush-radius')).toHaveCount(0);

    await page.getByTestId('tool-segmentationBrush').click();
    const radius = page.getByTestId('brush-radius');
    await expect(radius).toBeVisible();

    await radius.fill('30');
    await expect(page.getByTestId('brush-radius-value')).toHaveText('30px');
  });

  test('exports painted masks as COCO RLE from the demo toolbar', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 250, y: box.y + 160 });

    await page.getByTestId('export-coco').click();
    const exported = await page.getByTestId('exported-json').inputValue();
    const doc = JSON.parse(exported) as {
      rawAnnotationData: { format: string; data: { size: number[]; counts: string } };
    }[];

    expect(doc).toHaveLength(1);
    expect(doc[0]?.rawAnnotationData.format).toBe('coco-rle');
    // COCO reports [height, width] of the full image, and counts is the
    // compressed run-length string.
    expect(doc[0]?.rawAnnotationData.data.size).toHaveLength(2);
    expect(doc[0]?.rawAnnotationData.data.counts.length).toBeGreaterThan(0);
  });

  test('Delete removes the mask the brush just committed', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });
    expect(await readAnnotations(page)).toHaveLength(1);

    // The committed mask is the selected annotation, but `paint` mode keeps
    // every object inert, so Fabric has nothing selected. The tool must let
    // the key through to the host's keyboard map rather than swallow it.
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    expect(await readAnnotations(page)).toHaveLength(0);
  });

  test('resizing the brush mid-stroke keeps the stroke', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();

    // Resizing while painting is a routine gesture. It must not tear the tool
    // down: `deactivate()` cancels the open stroke, and everything painted so
    // far would be discarded with no feedback.
    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 160, { steps: 5 });
    await page.keyboard.press(']');
    await page.mouse.move(box.x + 280, box.y + 160, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(0);
  });
});
