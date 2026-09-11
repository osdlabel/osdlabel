import { test, expect } from '@playwright/test';

// The dev app's "Fracture" context is scoped to [landscape, portrait].
// - Line tool: maxCount 3, countScope 'per-image'
// - Rectangle tool: maxCount 2, countScope 'global' (default)

test.describe('Context Scoping', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('out-of-scope image disables all tools while keeping context active', async ({ page }) => {
    // Fracture context is active by default; landscape is the current image (in scope).
    const lineButton = page.getByTestId('tool-line');
    const rectButton = page.getByTestId('tool-rectangle');

    await expect(lineButton).toBeEnabled();
    await expect(rectButton).toBeEnabled();

    // Navigate to 'wide', which is NOT in Fracture's imageIds.
    await page.getByTestId('filmstrip-item-wide').click();
    await page.waitForTimeout(300);

    // Both drawing tools should be disabled — context is active but image is out of scope.
    await expect(lineButton).toBeDisabled();
    await expect(rectButton).toBeDisabled();

    // The toolbar buttons should still be visible (context hasn't changed).
    await expect(lineButton).toBeVisible();
    await expect(rectButton).toBeVisible();

    // Navigate back to landscape (in scope) — tools re-enabled.
    await page.getByTestId('filmstrip-item-landscape').click();
    await page.waitForTimeout(300);

    await expect(lineButton).toBeEnabled();
    await expect(rectButton).toBeEnabled();
  });

  test('out-of-scope disables tools for the tiled image as well', async ({ page }) => {
    const lineButton = page.getByTestId('tool-line');

    await expect(lineButton).toBeEnabled();

    // 'tiled' is also not in Fracture's imageIds.
    await page.getByTestId('filmstrip-item-tiled').click();
    await page.waitForTimeout(300);

    await expect(lineButton).toBeDisabled();
  });

  test('per-image counting: line limit resets when switching to another scoped image', async ({
    page,
  }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    const lineButton = page.getByTestId('tool-line');
    await expect(lineButton).toContainText('Line 0/3');
    await expect(lineButton).toBeEnabled();

    await lineButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Draw 3 lines on landscape to hit the per-image limit.
    for (let i = 0; i < 3; i++) {
      const yStart = box.y + 100 + i * 60;
      await page.mouse.move(box.x + 100, yStart);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, yStart, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    await expect(lineButton).toContainText('Line 3/3');
    await expect(lineButton).toBeDisabled();

    // Switch to portrait — also in Fracture's imageIds, but has its own per-image count.
    await page.getByTestId('filmstrip-item-portrait').click();
    await page.waitForTimeout(500);

    // Line count should be 0/3 for portrait — separate per-image counter.
    await expect(lineButton).toContainText('Line 0/3');
    await expect(lineButton).toBeEnabled();
  });

  test('global counting: rectangle count persists when switching between scoped images', async ({
    page,
  }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    const rectButton = page.getByTestId('tool-rectangle');
    await expect(rectButton).toContainText('Rect 0/2');
    await expect(rectButton).toBeEnabled();

    await rectButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Draw 1 rectangle on landscape.
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    await expect(rectButton).toContainText('Rect 1/2');

    // Switch to portrait — global count should carry over (not reset).
    await page.getByTestId('filmstrip-item-portrait').click();
    await page.waitForTimeout(500);

    await expect(rectButton).toContainText('Rect 1/2');
    await expect(rectButton).toBeEnabled();
  });
});
