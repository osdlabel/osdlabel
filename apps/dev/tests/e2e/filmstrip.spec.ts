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
    // Landscape is assigned to cell 0, so it should have a highlighted border
    const landscapeItem = page.getByTestId('filmstrip-item-landscape');
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

    // Both Landscape and Portrait should now be highlighted
    const landscapeBorder = await page
      .getByTestId('filmstrip-item-landscape')
      .evaluate((el) => getComputedStyle(el).borderColor);
    const portraitBorder = await page
      .getByTestId('filmstrip-item-portrait')
      .evaluate((el) => getComputedStyle(el).borderColor);
    expect(landscapeBorder).toContain('rgb(33, 150, 243)');
    expect(portraitBorder).toContain('rgb(33, 150, 243)');
  });
});
