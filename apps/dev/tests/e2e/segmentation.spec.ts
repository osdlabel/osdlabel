import { test, expect, type Page } from '@playwright/test';

interface StoredAnnotation {
  geometry: { type: string };
  toolType?: string;
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  const out: StoredAnnotation[] = [];
  for (const imageId of Object.keys(byImage)) {
    for (const id of Object.keys(byImage[imageId]!)) {
      out.push(byImage[imageId]![id]!);
    }
  }
  return out;
}

test.describe('Auto-segmentation tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Load the bundled local image so the viewer opens without network access.
    await page.getByTestId('filmstrip-item-jpg').click();
    // "General" context (index 2) includes the segmentation tool.
    await page.selectOption('select', { index: 2 });
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  test('box-drag prompt commits a polygon annotation', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');
    const x = box.x + 200;
    const y = box.y + 160;

    await page.getByTestId('tool-segmentation').click();

    // Drag a box prompt.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 120, y + 90, { steps: 8 });
    await page.mouse.up();

    // Wait for the (mock) decoder to return and render the preview.
    await page.waitForTimeout(600);
    // Nothing committed until the finish key is pressed.
    expect(await readAnnotations(page)).toHaveLength(0);

    // Commit the previewed mask.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const anns = await readAnnotations(page);
    expect(anns).toHaveLength(1);
    expect(anns[0]?.geometry.type).toBe('polygon');
    expect(anns[0]?.toolType).toBe('segmentation');
  });

  test('Escape discards the in-progress segmentation', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');
    const x = box.x + 220;
    const y = box.y + 180;

    await page.getByTestId('tool-segmentation').click();

    // A single click is a point prompt.
    await page.mouse.click(x, y);
    await page.waitForTimeout(600);

    // Cancel before committing.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    expect(await readAnnotations(page)).toHaveLength(0);
  });
});
