import { test, expect } from '@playwright/test';

test.describe('Constraint System', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the toolbar to be visible (app rendered)
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('toolbar shows only tools allowed by the active context', async ({ page }) => {
    // Default context is "Fracture" with line (max 3) and rectangle (max 2)
    await expect(page.getByTestId('tool-line')).toBeVisible();
    await expect(page.getByTestId('tool-rectangle')).toBeVisible();
    // Fracture context should NOT have circle, point, or polyline
    await expect(page.getByTestId('tool-circle')).not.toBeVisible();
    await expect(page.getByTestId('tool-point')).not.toBeVisible();
    await expect(page.getByTestId('tool-polyline')).not.toBeVisible();
    // Navigate and Select are always present
    await expect(page.getByTestId('tool-navigate')).toBeVisible();
    await expect(page.getByTestId('tool-select')).toBeVisible();
  });

  test('switching contexts updates the toolbar', async ({ page }) => {
    // Switch to "Pneumothorax" context (has polyline and circle)
    await page.selectOption('select', { index: 1 });

    await expect(page.getByTestId('tool-polyline')).toBeVisible();
    await expect(page.getByTestId('tool-circle')).toBeVisible();
    // Pneumothorax does NOT have line, rectangle, or point
    await expect(page.getByTestId('tool-line')).not.toBeVisible();
    await expect(page.getByTestId('tool-rectangle')).not.toBeVisible();
    await expect(page.getByTestId('tool-point')).not.toBeVisible();
  });

  test('drawing to the limit disables the tool button', async ({ page }) => {
    // Wait for the OSD viewer to open the image
    // The canvas element is created by FabricOverlay after OSD opens
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    // Give the overlay time to fully initialize
    await page.waitForTimeout(1000);

    // Get the line tool button and verify it starts enabled
    const lineButton = page.getByTestId('tool-line');
    await expect(lineButton).toBeEnabled();
    await expect(lineButton).toContainText('Line 0/3');

    // Select the line tool once
    await lineButton.click();

    // Get canvas position
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Draw 3 lines
    for (let i = 0; i < 3; i++) {
      const yStart = box.y + 100 + i * 60;
      const xStart = box.x + 100;
      const xEnd = box.x + 300;

      // Start
      await page.mouse.move(xStart, yStart);
      await page.mouse.down();
      // Drag
      await page.mouse.move(xEnd, yStart, { steps: 5 });
      // End
      await page.mouse.up();

      await page.waitForTimeout(300);
    }

    // Checking disabled state
    await expect(lineButton).toBeDisabled();
    await expect(lineButton).toContainText('Line 3/3');

    // Verify clicking it does nothing (tool doesn't change)
    await expect(page.getByTestId('status-tool')).toContainText('Select');
  });

  test('deleting an annotation re-enables the tool', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    const lineButton = page.getByTestId('tool-line');
    await lineButton.click();

    // Get canvas position
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Draw 3 lines to hit the limit
    for (let i = 0; i < 3; i++) {
      const yStart = box.y + 100 + i * 60;
      const xStart = box.x + 100;
      const xEnd = box.x + 300;

      await page.mouse.move(xStart, yStart);
      await page.mouse.down();
      await page.mouse.move(xEnd, yStart, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    await expect(lineButton).toBeDisabled();

    // Switch to select tool and click on an annotation to select it
    await page.getByTestId('tool-select').click();
    await page.waitForTimeout(200);

    // Click on approximately where the first line was drawn
    // Line 1 was at box.y + 100
    const clickY = box.y + 100;
    const clickX = box.x + 200; // Midpoint

    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(300);

    // Delete with keyboard
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    // The line tool should be re-enabled
    await expect(lineButton).toContainText('Line 2/3');
    await expect(lineButton).toBeEnabled();
  });

  test('status bar shows correct context and counts', async ({ page }) => {
    await expect(page.getByTestId('status-context')).toContainText('Fracture');
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');
    await expect(page.getByTestId('status-count')).toContainText('0');

    // Switch context
    await page.selectOption('select', { index: 1 });
    await expect(page.getByTestId('status-context')).toContainText('Pneumothorax');
  });
});
