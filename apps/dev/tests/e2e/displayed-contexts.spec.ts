import { test, expect } from '@playwright/test';
import { selectedAnnotationId } from './helpers/selection.js';

// The dev app has 3 contexts: Fracture (ctx-1), Pneumothorax (ctx-2), General (ctx-3).
// Fracture is active by default, scoped to [landscape, portrait].
// The "Show:" checkboxes control displayedContextIds via data-testid="display-ctx-{id}".

test.describe('Displayed Contexts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('active context always displayed without explicit displayedContextIds', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Draw a rectangle in Fracture context (active by default)
    const rectButton = page.getByTestId('tool-rectangle');
    await rectButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // No display checkboxes checked, but active context annotations should still show
    await expect(rectButton).toContainText('Rect 1/2');

    // Verify annotation count attribute on viewer cell container
    const cell = page.locator('[data-annotation-count]').first();
    await expect(cell).toHaveAttribute('data-annotation-count', '1');
  });

  test('annotations from displayed context appear on canvas', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Draw a rectangle in Fracture context on landscape
    const rectButton = page.getByTestId('tool-rectangle');
    await rectButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    await expect(rectButton).toContainText('Rect 1/2');

    // Switch active context to Pneumothorax (index 1)
    await page.locator('select').selectOption({ index: 1 });
    await page.waitForTimeout(500);

    // Fracture annotations should no longer be visible (only active context shows)
    const cell = page.locator('[data-annotation-count]').first();
    await expect(cell).toHaveAttribute('data-annotation-count', '0');

    // Enable Fracture as a displayed context
    await page.getByTestId('display-ctx-ctx-1').check();
    await page.waitForTimeout(500);

    // Fracture annotation should now be visible
    await expect(cell).toHaveAttribute('data-annotation-count', '1');
  });

  test('displayed context annotations are not selectable', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Draw a rectangle in Fracture context
    const rectButton = page.getByTestId('tool-rectangle');
    await rectButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const rectCenterX = box.x + 175;
    const rectCenterY = box.y + 150;

    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const selectButton = page.getByTestId('tool-select');

    // Positive control: while Fracture is active, the same click selects the
    // rectangle. Without this, the negative assertion below is only as good as
    // the probe — and an earlier probe could never see a selection (#193).
    await selectButton.click();
    await page.waitForTimeout(200);
    await page.mouse.click(rectCenterX, rectCenterY);
    await page.waitForTimeout(300);
    expect(await selectedAnnotationId(page)).not.toBeNull();

    // Deselect by clicking empty canvas, so the selection cannot carry over.
    // The rectangle spans (100,100)–(250,200) from the canvas origin, so this
    // point is clear of it; the `toBeNull()` below fails if that stops holding.
    await page.mouse.click(box.x + 400, box.y + 350);
    await page.waitForTimeout(300);
    expect(await selectedAnnotationId(page)).toBeNull();

    // Switch to Pneumothorax and display Fracture
    await page.locator('select').selectOption({ index: 1 });
    await page.waitForTimeout(500);
    await page.getByTestId('display-ctx-ctx-1').check();
    await page.waitForTimeout(500);

    // The Fracture annotation is back on the canvas, but read-only.
    const cell = page.locator('[data-annotation-count]').first();
    await expect(cell).toHaveAttribute('data-annotation-count', '1');

    // Try to select the Fracture annotation with the select tool
    await selectButton.click();
    await page.waitForTimeout(200);
    await page.mouse.click(rectCenterX, rectCenterY);
    await page.waitForTimeout(300);

    expect(await selectedAnnotationId(page)).toBeNull();
  });

  test('active context annotations remain editable with other contexts displayed', async ({
    page,
  }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Enable General (ctx-3) as a displayed context
    await page.getByTestId('display-ctx-ctx-3').check();
    await page.waitForTimeout(300);

    // With Fracture still active, draw a line
    const lineButton = page.getByTestId('tool-line');
    await expect(lineButton).toContainText('Line 0/3');
    await lineButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    await page.mouse.move(box.x + 100, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 150, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Active context drawing should still work
    await expect(lineButton).toContainText('Line 1/3');
  });

  test('unchecking displayed context removes its annotations', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Draw a rectangle in Fracture context
    const rectButton = page.getByTestId('tool-rectangle');
    await rectButton.click();

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Switch to Pneumothorax and enable Fracture as displayed
    await page.locator('select').selectOption({ index: 1 });
    await page.waitForTimeout(500);
    await page.getByTestId('display-ctx-ctx-1').check();
    await page.waitForTimeout(500);

    const cell = page.locator('[data-annotation-count]').first();
    await expect(cell).toHaveAttribute('data-annotation-count', '1');

    // Uncheck Fracture display
    await page.getByTestId('display-ctx-ctx-1').uncheck();
    await page.waitForTimeout(500);

    // Fracture annotation should be gone
    await expect(cell).toHaveAttribute('data-annotation-count', '0');
  });
});
