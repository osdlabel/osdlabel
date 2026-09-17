import { test, expect } from '@playwright/test';

test.describe('Filmstrip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="filmstrip"]', { timeout: 10000 });
  });

  test('should display all available images', async ({ page }) => {
    await expect(page.getByTestId('filmstrip-item-landscape')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-portrait')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-wide')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-tiled')).toBeVisible();
  });

  test('should assign image to active cell on click', async ({ page }) => {
    // Cell 0 starts with Landscape. Click Portrait to change it.
    await page.getByTestId('filmstrip-item-portrait').click();

    // Verify no placeholder (image was assigned)
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
  });

  test('should highlight assigned images', async ({ page }) => {
    // Landscape is assigned to cell 0, which is also the active cell.
    const landscapeItem = page.getByTestId('filmstrip-item-landscape');
    await expect(landscapeItem).toHaveAttribute('data-assignment', 'active');
    const border = await landscapeItem.evaluate((el) => getComputedStyle(el).borderColor);
    // The assigned image should have the blue highlight border
    expect(border).toContain('rgb(33, 150, 243)'); // #2196F3
  });

  test('should assign different images to different cells', async ({ page }) => {
    // Expand to 2x1
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // Click the empty cell to make it active
    await page.locator('text=Assign an image').first().click();

    // Assign Portrait to the second cell
    await page.getByTestId('filmstrip-item-portrait').click();

    // Both cells should now have images
    await expect(page.locator('text=Assign an image')).toHaveCount(0);

    // Both are assigned, but to different cells — and cell 1 is the active one.
    // Portrait reads as 'active' (clicking it clears cell 1); Landscape reads as
    // 'other' (clicking it assigns into cell 1, it does not clear cell 0).
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'other',
    );
  });
});
