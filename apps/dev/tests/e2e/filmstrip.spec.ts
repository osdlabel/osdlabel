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

    // The cell returns to the empty state every cell starts in. Assert the
    // specific cell, not a global placeholder count — a count cannot tell
    // "cell 0 was cleared" from "some other cell was cleared instead".
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
    await expect(landscape).toHaveAttribute('data-assignment', 'none');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toHaveCount(0);

    // And the round trip works: clicking it again re-assigns.
    await landscape.click();
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
    // The rebuilt cell is a live viewer, not just restored markup.
    await expect(page.locator('.openseadragon-canvas')).toHaveCount(1);
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
    await page.getByTestId('cell-placeholder-1').click();

    const landscape = page.getByTestId('filmstrip-item-landscape');
    await expect(landscape).toHaveAttribute('data-assignment', 'other');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toHaveCount(0);

    await landscape.click();

    // Landscape is now in both cells; nothing was cleared.
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
  });

  test('clears the ACTIVE cell, not cell 0, when a later cell is active', async ({ page }) => {
    // Every other unassign path runs with cell 0 active, so a filmstrip that
    // cleared the wrong index — hardcoded 0, or any stale index — would pass
    // the rest of this suite untouched.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // Activate the empty cell 1 and give it its own image.
    await page.getByTestId('cell-placeholder-1').click();
    await page.getByTestId('filmstrip-item-portrait').click();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );

    // Clear cell 1 by clicking its own thumbnail again.
    await page.getByTestId('filmstrip-item-portrait').click();

    // Cell 1 is empty and cell 0 is untouched.
    await expect(page.getByTestId('cell-placeholder-1')).toBeVisible();
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'other',
    );
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'none',
    );
  });

  test('clears a bottom-row cell on a multi-row grid', async ({ page }) => {
    // Every other filmstrip test uses a 2x1 grid, where rows == 1 and the cell
    // count equals the column count, so nothing there can tell a cell-count
    // derivation that forgot `gridRows` from a correct one.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-2').click();

    // Reach cell 3 by its shortcut rather than by clicking the placeholder.
    // The shortcut is screened against `getGridCellCount`, so a count that
    // dropped `gridRows` would refuse `4` here and the rest of this test would
    // act on the wrong cell — which clicking the placeholder directly would
    // not catch.
    await page.keyboard.press('4');
    await expect(page.getByTestId('grid-cell-3')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('filmstrip-item-portrait').click();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );
    await expect(page.getByTestId('filmstrip-clear-portrait')).toBeVisible();

    // Clicking it again must clear cell 3, not re-assign it.
    await page.getByTestId('filmstrip-item-portrait').click();

    await expect(page.getByTestId('cell-placeholder-3')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'none',
    );
    // Cell 0 keeps its seeded image throughout.
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
  });

  test('a cell-selection shortcut past the end of the grid is ignored', async ({ page }) => {
    // The shortcuts map each digit to a fixed cell index, so they have to be
    // screened against the grid. On the default 1x1 grid, letting `9` through
    // would leave the active cell offscreen: the clear badge disappears with no
    // visible cause, and every thumbnail click writes an assignment nobody can
    // see until the grid grows.
    const landscape = page.getByTestId('filmstrip-item-landscape');
    await expect(landscape).toHaveAttribute('data-assignment', 'active');

    await page.keyboard.press('9');

    // Still acting on cell 0, so the clear affordance is still offered.
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toBeVisible();

    // And a click still clears the visible cell rather than a phantom one.
    await landscape.click();
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
  });

  test('renders the three assignment states distinguishably', async ({ page }) => {
    // The tri-state border is the whole reason the toggle is safe to offer.
    // If 'other' rendered like 'active', the misleading highlight this change
    // set out to remove would be back, and every state assertion above would
    // still pass.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();
    await page.getByTestId('cell-placeholder-1').click();
    await page.getByTestId('filmstrip-item-portrait').click();

    const borderOf = (id: string) =>
      page.getByTestId(`filmstrip-item-${id}`).evaluate((el) => getComputedStyle(el).borderColor);

    // portrait = active (cell 1), landscape = other (cell 0), wide = none.
    const [active, other, none] = await Promise.all([
      borderOf('portrait'),
      borderOf('landscape'),
      borderOf('wide'),
    ]);

    expect(new Set([active, other, none]).size).toBe(3);
  });
});
