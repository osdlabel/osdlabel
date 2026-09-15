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

  test('should unassign the active cell when its image is clicked again', async ({ page }) => {
    const landscape = page.getByTestId('filmstrip-item-landscape');

    // Cell 0 starts assigned to Landscape and active, so it offers the clear
    // affordance.
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toBeVisible();
    await expect(page.locator('text=Assign an image')).toHaveCount(0);

    await landscape.click();

    // The cell returns to the empty state every cell starts in.
    await expect(page.locator('text=Assign an image')).toHaveCount(1);
    await expect(landscape).toHaveAttribute('data-assignment', 'none');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toHaveCount(0);

    // And the round trip works: clicking it again re-assigns.
    await landscape.click();
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
  });

  test('clicking an image assigned to another cell assigns rather than clears', async ({
    page,
  }) => {
    // The regression the tri-state border exists to prevent: a highlighted
    // thumbnail that belongs to a different cell must not read as "click to
    // clear", and must not empty anything when clicked.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // Make the empty cell 1 active.
    await page.locator('text=Assign an image').first().click();

    const landscape = page.getByTestId('filmstrip-item-landscape');
    await expect(landscape).toHaveAttribute('data-assignment', 'other');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toHaveCount(0);

    await landscape.click();

    // Landscape is now in both cells; nothing was cleared.
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
  });
});
