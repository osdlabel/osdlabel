import { test, expect } from '@playwright/test';

test.describe('Grid View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('should start at 1x1 grid', async ({ page }) => {
    const gridSize = page.getByTestId('grid-size');
    await expect(gridSize).toContainText('1x1');
  });

  test('should expand to 2x2 grid', async ({ page }) => {
    // Open selector
    await page.getByTestId('grid-selector-trigger').click();
    // Select 2x2
    await page.getByTestId('grid-cell-2-2').click();

    await expect(page.getByTestId('grid-size')).toContainText('2x2');

    // Verify 4 cells exist (3 empty placeholders + 1 with image)
    const placeholders = page.locator('text=Assign an image');
    await expect(placeholders).toHaveCount(3);
  });

  test('should assign different images to each cell via filmstrip', async ({ page }) => {
    // Expand to 2x1
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // First cell should already have Landscape
    // Click cell 1 (the empty one) to activate it
    const placeholders = page.locator('text=Assign an image');
    await placeholders.first().click();

    // Assign Portrait to cell 1 via filmstrip
    await page.getByTestId('filmstrip-item-portrait').click();

    // Both cells should now have images (no more placeholders)
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
  });

  test('should shrink grid and preserve cell 0 assignments', async ({ page }) => {
    // Expand to 2x1
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();
    await expect(page.getByTestId('grid-size')).toContainText('2x1');

    // Shrink back to 1x1
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-1-1').click();
    await expect(page.getByTestId('grid-size')).toContainText('1x1');

    // Cell 0 should still have the Landscape image (no placeholder)
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
  });
});
