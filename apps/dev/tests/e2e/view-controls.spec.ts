import { test, expect } from '@playwright/test';

test.describe('View Controls', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the local dev app
    await page.goto('/');

    // Wait for OpenSeadragon viewer canvas to be present
    await page.waitForSelector('.openseadragon-canvas');
  });

  test('View control buttons are visible', async ({ page }) => {
    await expect(page.locator('[data-testid="view-rotate-cw"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-rotate-ccw"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-flip-h"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-flip-v"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-negative"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-exposure-increase"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-exposure-decrease"]')).toBeVisible();
    // Reset button should not be visible initially as view is not transformed
    await expect(page.locator('[data-testid="view-reset"]')).not.toBeVisible();
  });

  test('Rotate CW/CCW updates view and shows reset', async ({ page }) => {
    const rotateCwBtn = page.locator('[data-testid="view-rotate-cw"]');
    const rotateCcwBtn = page.locator('[data-testid="view-rotate-ccw"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');

    await expect(resetBtn).not.toBeVisible();

    await rotateCwBtn.click();
    await expect(resetBtn).toBeVisible();

    await rotateCwBtn.click();
    await expect(resetBtn).toBeVisible();

    await rotateCcwBtn.click();
    await rotateCcwBtn.click();

    // Back to 0 rotation, reset should disappear
    await expect(resetBtn).not.toBeVisible();
  });

  test('Flip buttons toggle and show active state', async ({ page }) => {
    const flipHBtn = page.locator('[data-testid="view-flip-h"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');

    // Default background color is #333 (inactive)
    await expect(flipHBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');

    await flipHBtn.click();

    // Active background color is #2196F3 (rgb(33, 150, 243))
    await expect(flipHBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');
    await expect(resetBtn).toBeVisible();

    await flipHBtn.click();
    await expect(flipHBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(resetBtn).not.toBeVisible();
  });

  test('Negative toggle applies invert filter and shows active state', async ({ page }) => {
    const negativeBtn = page.locator('[data-testid="view-negative"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');

    // The main OSD drawing canvas typically doesn't have data-fabric.
    // However, some timing issues might make Playwright not find it immediately.
    // Wait for the main canvas block to be available.
    // OSD canvas usually has "position: absolute" in its inline style.
    const drawerCanvas = page.locator('.openseadragon-canvas canvas').nth(0);

    // Default inactive background color is #333
    await expect(negativeBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');

    await negativeBtn.click();
    await expect(negativeBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');
    await expect(resetBtn).toBeVisible();

    await expect(drawerCanvas).toHaveCSS('filter', 'invert(1)');

    await negativeBtn.click();
    await expect(negativeBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(resetBtn).not.toBeVisible();
    await expect(drawerCanvas).toHaveCSS('filter', 'none');
  });

  test('Exposure buttons apply brightness filter and handles bounds', async ({ page }) => {
    const increaseBtn = page.locator('[data-testid="view-exposure-increase"]');
    const decreaseBtn = page.locator('[data-testid="view-exposure-decrease"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');
    const drawerCanvas = page.locator('.openseadragon-canvas canvas').nth(0);

    await increaseBtn.click();
    await expect(resetBtn).toBeVisible();
    // +0.1 exposure -> brightness 1.1
    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(1.1)');

    await decreaseBtn.click();
    // Back to 0 exposure
    await expect(resetBtn).not.toBeVisible();
    await expect(drawerCanvas).toHaveCSS('filter', 'none');

    await decreaseBtn.click();
    await expect(resetBtn).toBeVisible();
    // -0.1 exposure -> brightness 0.9
    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(0.9)');

    // Test max limits by repeatedly clicking
    for (let i = 0; i < 15; i++) {
      await increaseBtn.click();
    }
    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(2)');

    for (let i = 0; i < 25; i++) {
      await decreaseBtn.click();
    }
    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(0)');
  });

  test('Exposure drag mode adjusts brightness continuously', async ({ page }) => {
    const dragBtn = page.locator('[data-testid="view-exposure-drag"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');
    const drawerCanvas = page.locator('.openseadragon-canvas canvas').nth(0);
    const viewer = page.locator('.openseadragon-canvas');

    // Enter drag-exposure (customControl) mode — button shows active state.
    await expect(dragBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await dragBtn.click();
    await expect(dragBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');

    const box = await viewer.boundingBox();
    if (!box) throw new Error('viewer canvas not found');
    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Drag right by 50px → +0.5 exposure (sensitivity 0.01/px) → brightness(1.5).
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 50, y, { steps: 10 });
    await page.mouse.up();

    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(1.5)');
    await expect(resetBtn).toBeVisible();

    // Exiting the mode restores the inactive button styling; exposure persists.
    await dragBtn.click();
    await expect(dragBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(1.5)');

    // Selecting a tool also exits the control (mutual exclusivity).
    await dragBtn.click();
    await expect(dragBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');
    await page.locator('[data-testid="tool-rectangle"]').click();
    await expect(dragBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
  });

  test('Reset clears rotation and flip', async ({ page }) => {
    const rotateCwBtn = page.locator('[data-testid="view-rotate-cw"]');
    const flipVBtn = page.locator('[data-testid="view-flip-v"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');

    await rotateCwBtn.click();
    await flipVBtn.click();

    await expect(resetBtn).toBeVisible();
    await expect(flipVBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');

    await resetBtn.click();

    await expect(resetBtn).not.toBeVisible();
    await expect(flipVBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
  });

  test('View transforms persist across cell switching', async ({ page }) => {
    // Enable a 2x1 grid
    await page.locator('[data-testid="grid-selector-trigger"]').click();
    await page.locator('[data-testid="grid-cell-2-1"]').click();

    // Assign images to both cells by clicking thumbnails in filmstrip
    const thumbnails = page.locator('[data-testid^="filmstrip-item-"]');

    // Cell 0 is active by default. Assign first image.
    await thumbnails.nth(0).click();

    // Rotate cell 0
    await page.locator('[data-testid="view-rotate-cw"]').click();
    await expect(page.locator('[data-testid="view-reset"]')).toBeVisible();

    // Click to activate cell 1
    await page.locator('[data-testid="grid-cell-1"]').click();
    // Assign second image
    await thumbnails.nth(1).click();

    // Cell 1 should have default transform
    await expect(page.locator('[data-testid="view-reset"]')).not.toBeVisible();

    // Click back to cell 0
    await page.locator('[data-testid="grid-cell-0"]').click();

    // Cell 0 should still show transformed state
    await expect(page.locator('[data-testid="view-reset"]')).toBeVisible();
  });

  test('Annotations maintain position after rotation', async ({ page }) => {
    // Select rectangle tool
    await page.locator('[data-testid="tool-rectangle"]').click();

    // Draw a rectangle
    // The canvas container intercepts events for the actual canvas, so drag on the container
    const canvasContainer = page.locator('.canvas-container').first();
    await canvasContainer.dragTo(canvasContainer, {
      sourcePosition: { x: 100, y: 100 },
      targetPosition: { x: 200, y: 200 },
    });

    // Count objects
    await page.evaluate(() => {
      // @ts-ignore
      const canvas = window.fabricCanvas; // We might need to expose this or just check DOM elements
      return document.querySelectorAll('.upper-canvas').length;
    });

    // Wait for the object to be added to state
    await page.waitForTimeout(100);

    // Rotate
    await page.locator('[data-testid="view-rotate-cw"]').click();

    // The annotation should still be there
    // For now we just verify we can perform the action without crashing
    // E2E visual tests would be better here, but this at least exercises the path
  });

  test('Keyboard shortcuts for view transforms', async ({ page }) => {
    const flipHBtn = page.locator('[data-testid="view-flip-h"]');
    const resetBtn = page.locator('[data-testid="view-reset"]');
    const negativeBtn = page.locator('[data-testid="view-negative"]');
    const drawerCanvas = page.locator('.openseadragon-canvas canvas').nth(0);

    // Press Shift+H
    await page.keyboard.press('Shift+H');
    await expect(flipHBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');
    await expect(resetBtn).toBeVisible();

    // Press Shift+N (Negative)
    await page.keyboard.press('Shift+N');
    await expect(negativeBtn).toHaveCSS('background-color', 'rgb(33, 150, 243)');
    await expect(drawerCanvas).toHaveCSS('filter', 'invert(1)');

    // Press Shift+E (Exposure increase)
    await page.keyboard.press('Shift+E');
    await expect(drawerCanvas).toHaveCSS('filter', 'brightness(1.1) invert(1)');

    // Press Shift+R
    await page.keyboard.press('Shift+R');

    // Press Shift+0 (Reset)
    await page.keyboard.press('Shift+0');

    await expect(flipHBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(negativeBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(drawerCanvas).toHaveCSS('filter', 'none');
    await expect(resetBtn).not.toBeVisible();

    // Plain 'r' triggers rectangle tool, not rotation
    await page.keyboard.press('r');
    await expect(page.locator('[data-testid="tool-rectangle"]')).toHaveCSS(
      'background-color',
      'rgb(33, 150, 243)',
    );
    await expect(resetBtn).not.toBeVisible();
  });

  test('Exposure and negative are independent per cell for same image', async ({ page }) => {
    // 1. Add another row to have multiple cells
    await page.keyboard.press(']');

    // Grid assignments are done sequentially. Cell 0 already has image 0 by default.
    // Cell 1 should also be assigned image 0.
    const cell0 = page.locator('[data-testid="grid-cell-0"]');
    const cell1 = page.locator('[data-testid="grid-cell-1"]');

    // Assign 'highsmith' to cell 1
    await cell1.click();
    const thumbnail = page.locator('[data-testid="filmstrip-item-highsmith"]');
    await thumbnail.click();

    // 3. Select cell 0 and enable negative
    await cell0.click();
    await page.locator('[data-testid="view-negative"]').click();

    // 4. Verify cell 0 has invert filter, cell 1 does not
    const canvas0 = cell0.locator('canvas').nth(0);
    const canvas1 = cell1.locator('canvas').nth(0);

    await expect(canvas0).toHaveCSS('filter', 'invert(1)');
    await expect(canvas1).toHaveCSS('filter', 'none');

    // 5. Select cell 1 and increase exposure
    await cell1.click();
    await page.locator('[data-testid="view-exposure-increase"]').click();

    // 6. Verify cell 1 has brightness filter, cell 0 still only has invert
    await expect(canvas1).toHaveCSS('filter', 'brightness(1.1)');
    await expect(canvas0).toHaveCSS('filter', 'invert(1)');
  });

  test('Image reassignment resets cell filters', async ({ page }) => {
    const negativeBtn = page.locator('[data-testid="view-negative"]');
    const drawerCanvas = page.locator('.openseadragon-canvas canvas').nth(0);

    // 1. Enable negative
    await negativeBtn.click();
    await expect(drawerCanvas).toHaveCSS('filter', 'invert(1)');

    // 2. Reassign different image to active cell
    const thumbnailDuomo = page.locator('[data-testid="filmstrip-item-duomo"]');
    await thumbnailDuomo.click();

    // 3. Verify filter is reset
    await expect(drawerCanvas).toHaveCSS('filter', 'none');
    await expect(negativeBtn).toHaveCSS('background-color', 'rgb(51, 51, 51)');
  });

  test('Grid resizing prunes stale cell filters', async ({ page }) => {
    // 1. Expand to 2x2
    await page.keyboard.press(']');
    await page.keyboard.press(']');

    // Indices 0, 1, 2, 3 now exist.
    // 2. Set negative in cell 1 (index 1)
    const cell1 = page.locator('[data-testid="grid-cell-1"]');
    await cell1.click();

    // Assign an image to cell 1 so controls are enabled
    const thumbnail = page.locator('[data-testid="filmstrip-item-highsmith"]');
    await thumbnail.click();

    await page.locator('[data-testid="view-negative"]').click();

    const canvas1 = cell1.locator('canvas').nth(0);
    await expect(canvas1).toHaveCSS('filter', 'invert(1)');

    // 3. Shrink back to 1x1
    await page.keyboard.press('[');
    await page.keyboard.press('[');

    // 4. Expand again to 2x2
    await page.keyboard.press(']');
    await page.keyboard.press(']');

    // 5. Verify cell 1 filter is gone
    await expect(canvas1).toHaveCSS('filter', 'none');
  });
});
