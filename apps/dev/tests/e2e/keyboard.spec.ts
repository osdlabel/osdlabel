import { test, expect } from '@playwright/test';

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('Tool shortcuts switch active tool', async ({ page }) => {
    // Switch to 'General' context to enable all tools
    await page.getByRole('combobox').selectOption({ label: 'General' });

    // Initial state: Navigate
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');

    // 'r' -> Rectangle
    await page.keyboard.press('r');
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');
    await expect(page.getByTestId('tool-rectangle')).toHaveCSS('font-weight', '700'); // Check bold

    // 'v' -> Select
    await page.keyboard.press('v');
    await expect(page.getByTestId('status-tool')).toContainText('Select');

    // 'c' -> Circle
    await page.keyboard.press('c');
    await expect(page.getByTestId('status-tool')).toContainText('Circle');

    // 'l' -> Line
    await page.keyboard.press('l');
    await expect(page.getByTestId('status-tool')).toContainText('Line');

    // 'p' -> Point
    await page.keyboard.press('p');
    await expect(page.getByTestId('status-tool')).toContainText('Point');

    // 'd' -> Polyline
    await page.keyboard.press('d');
    await expect(page.getByTestId('status-tool')).toContainText('Polyline');
  });

  test('Escape key cascades correctly', async ({ page }) => {
    // Switch to Rectangle
    await page.keyboard.press('r');
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');

    // Press Escape -> Should go to Navigate (since no selection and no drawing)
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');

    // Switch to Select
    await page.keyboard.press('v');
    await expect(page.getByTestId('status-tool')).toContainText('Select');

    // Press Escape -> Navigate
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');
  });

  test('Grid shortcuts resize grid', async ({ page }) => {
    // Check initial size (assuming 1x1)
    const gridSize = page.getByTestId('grid-size');
    await expect(gridSize).toContainText('1x1');

    // Increase columns with '='
    await page.keyboard.press('=');
    await expect(gridSize).toContainText('2x1');

    // Increase again
    await page.keyboard.press('=');
    await expect(gridSize).toContainText('3x1');

    // Decrease columns with '-'
    await page.keyboard.press('-');
    await expect(gridSize).toContainText('2x1');

    // Check clamping at 1
    await page.keyboard.press('-');
    await expect(gridSize).toContainText('1x1');
    await page.keyboard.press('-');
    await expect(gridSize).toContainText('1x1');

    // Check clamping at Max (4)
    await page.keyboard.press('='); // 2
    await page.keyboard.press('='); // 3
    await page.keyboard.press('='); // 4
    await expect(gridSize).toContainText('4x1');
    await page.keyboard.press('='); // Should stay 4
    await expect(gridSize).toContainText('4x1');

    // Return to 1x1
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await expect(gridSize).toContainText('1x1');

    // Increase rows with ']'
    await page.keyboard.press(']');
    await expect(gridSize).toContainText('1x2');

    // Increase rows again
    await page.keyboard.press(']');
    await expect(gridSize).toContainText('1x3');

    // Decrease rows with '['
    await page.keyboard.press('[');
    await expect(gridSize).toContainText('1x2');

    // Check clamping at 1 row
    await page.keyboard.press('[');
    await expect(gridSize).toContainText('1x1');
    await page.keyboard.press('[');
    await expect(gridSize).toContainText('1x1');

    // Check clamping at Max (4) for rows
    await page.keyboard.press(']'); // 2
    await page.keyboard.press(']'); // 3
    await page.keyboard.press(']'); // 4
    await expect(gridSize).toContainText('1x4');
    await page.keyboard.press(']'); // Should stay 4
    await expect(gridSize).toContainText('1x4');
  });

  test('Grid cell selection shortcuts (1-9)', async ({ page }) => {
    // Expand grid to 3x1 so we have cells 0, 1, 2
    await page.keyboard.press('=');
    await page.keyboard.press('=');
    await expect(page.getByTestId('grid-size')).toContainText('3x1');

    const cell0 = page.getByTestId('grid-cell-0');
    const cell1 = page.getByTestId('grid-cell-1');

    // Check initial active state
    await expect(cell0).toHaveAttribute('data-active', 'true');
    await expect(cell1).toHaveAttribute('data-active', 'false');

    // Press '2' -> Activate cell 1
    await page.keyboard.press('2');
    await expect(cell1).toHaveAttribute('data-active', 'true');
    await expect(cell0).toHaveAttribute('data-active', 'false');

    // Press '1' -> Activate cell 0
    await page.keyboard.press('1');
    await expect(cell0).toHaveAttribute('data-active', 'true');
  });

  test('Shortcuts are suppressed in input fields', async ({ page }) => {
    // Inject an input
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.setAttribute('data-testid', 'test-input');
      input.style.position = 'fixed';
      input.style.top = '10px';
      input.style.right = '10px';
      input.style.zIndex = '9999';
      document.body.appendChild(input);
    });

    const input = page.getByTestId('test-input');
    await input.focus();

    // Verify tool doesn't change when typing 'r'
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');
    await page.keyboard.type('r');
    await expect(input).toHaveValue('r');
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');

    // Verify Escape works? No, Escape usually blurs input or is handled by input.
    // The hook suppresses IF target is input.
    // So pressing Escape in input should NOT trigger global cancel.
    await page.keyboard.press('Escape');

    await input.blur();
    await page.keyboard.press('r'); // Switch to Rect
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');

    await input.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');
  });

  test('OSD built-in keyboard shortcuts are suppressed', async ({ page }) => {
    // Switch to 'General' context to enable all tools
    await page.getByRole('combobox').selectOption({ label: 'General' });
    // Wait for OSD canvas and FabricOverlay (which registers the canvas-key handler)
    await page.waitForSelector('.openseadragon-canvas');
    await page.waitForSelector('canvas.upper-canvas');

    // Click the viewer to ensure OSD canvas has focus
    await page.locator('.openseadragon-canvas').first().click();

    // Helper to read OSD's internal viewport state via the test hook
    // FabricOverlay exposes __osdViewer on the OSD canvas container when testMode is true
    const getOsdState = () =>
      page.evaluate(() => {
        const osdCanvas = document.querySelector('.openseadragon-canvas') as Record<
          string,
          unknown
        > | null;
        const viewer = osdCanvas?.__osdViewer as
          | {
              viewport: {
                getFlip: () => boolean;
                getCenter: (current: boolean) => { x: number; y: number };
                getRotation: () => number;
              };
            }
          | undefined;
        if (!viewer?.viewport) return null;
        const center = viewer.viewport.getCenter(false);
        return {
          flipped: viewer.viewport.getFlip(),
          centerX: center.x,
          centerY: center.y,
          rotation: viewer.viewport.getRotation(),
        };
      });

    const before = await getOsdState();
    expect(before).not.toBeNull();

    // Press arrow keys — should NOT cause OSD to pan
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');

    const afterArrows = await getOsdState();
    expect(afterArrows!.centerX.toFixed(6)).toBe(before!.centerX.toFixed(6));
    expect(afterArrows!.centerY.toFixed(6)).toBe(before!.centerY.toFixed(6));

    // Press 'f' — should activate Free Hand tool, NOT flip OSD viewport
    await page.keyboard.press('f');
    await expect(page.getByTestId('status-tool')).toContainText('FreeHandPath');
    const afterF = await getOsdState();
    expect(afterF?.flipped).toBe(false);

    // Press Escape to go back to navigate, then 'r' — should NOT rotate OSD
    await page.keyboard.press('Escape');
    await page.keyboard.press('r');
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');
    const afterR = await getOsdState();
    expect(afterR?.rotation).toBe(before!.rotation);
  });
});
