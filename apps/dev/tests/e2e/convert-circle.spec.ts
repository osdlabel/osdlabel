import { test, expect, type Page } from '@playwright/test';

interface StoredAnnotation {
  geometry: { type: string };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

async function readGeometryTypes(page: Page): Promise<string[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  const types: string[] = [];
  for (const imageId of Object.keys(byImage)) {
    for (const id of Object.keys(byImage[imageId]!)) {
      types.push(byImage[imageId]![id]!.geometry.type);
    }
  }
  return types;
}

test.describe('Circle → rectangle conversion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Load the bundled local image so the viewer opens without network access.
    await page.getByTestId('filmstrip-item-jpg').click();
    // "General" context (index 2) allows both circle and rectangle.
    await page.selectOption('select', { index: 2 });
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  test('converts a selected circle to its bounding rectangle', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');
    const cx = box.x + 250;
    const cy = box.y + 200;

    // Draw a circle (center drag-out radius).
    await page.getByTestId('tool-circle').click();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // A circle exists, and with nothing selected the convert button is absent.
    expect(await readGeometryTypes(page)).toContain('circle');
    await expect(page.getByTestId('convert-to-rect')).toHaveCount(0);

    // Select the circle.
    await page.getByTestId('tool-select').click();
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(200);

    // The contextual convert button appears and is enabled.
    const convertBtn = page.getByTestId('convert-to-rect');
    await expect(convertBtn).toBeVisible();
    await expect(convertBtn).toBeEnabled();

    await convertBtn.click();
    await page.waitForTimeout(300);

    // The circle is now a rectangle.
    const types = await readGeometryTypes(page);
    expect(types).toContain('rectangle');
    expect(types).not.toContain('circle');
  });
});
