import { test, expect } from '@playwright/test';

test.describe('Race Condition: Cell Switching & Key Handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('Tool shortcuts usually intercepted by tools (like "c" for Polyline closing) should work after switching cell 1->0', async ({
    page,
  }) => {
    // 1. Expand grid to 2x1 so we have Cell 0 and Cell 1
    // Open selector
    await page.getByTestId('grid-selector-trigger').click();
    // Select 2x1
    await page.getByTestId('grid-cell-2-1').click();
    await expect(page.getByTestId('grid-size')).toContainText('2x1');

    // 2. Activate Cell 1 and assign an image
    // Cell 1 is initially empty. We need it to have an image so the annotation tool hook
    // is fully active (and thus registers/clears handlers).
    await page.getByTestId('grid-cell-1').click();
    await expect(page.getByTestId('grid-cell-1')).toHaveAttribute('data-active', 'true');

    // Assign an image (e.g., the first one available in the filmstrip or placeholder)
    // The placeholder text "Assign an image" should be visible in the cell.
    // Safe bet: click the first item in the filmstrip.
    await page.locator('[data-testid^="filmstrip-item-"]').first().click();

    // Wait for image to load/placeholder to disappear
    await expect(page.locator('text=Assign an image')).toHaveCount(0);

    // 3. Activate Cell 0 (Trigger the race condition: 1 -> 0)
    await page.getByTestId('grid-cell-0').click();
    await expect(page.getByTestId('grid-cell-0')).toHaveAttribute('data-active', 'true');

    // 4. Switch to 'General' context to ensure Polyline tool is enabled
    const contextSelector = page.getByRole('combobox');
    if (await contextSelector.isVisible()) {
      await contextSelector.selectOption({ label: 'General' });
    }

    // 5. Select Polyline Tool ('d')
    // We can use the global shortcut 'd' to select it first.
    // This also verifies global shortcuts work.
    await page.keyboard.press('d');
    await expect(page.getByTestId('status-tool')).toContainText('Polyline');

    // 6. Draw a polyline (3 points)
    // We need to click on the canvas.
    const canvas = page.locator('canvas.upper-canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    // Give overlay time to settle
    await page.waitForTimeout(1000);

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Point 1
    await page.mouse.click(box.x + 100, box.y + 100);
    await page.waitForTimeout(100);
    // Point 2
    await page.mouse.click(box.x + 200, box.y + 100);
    await page.waitForTimeout(100);
    // Point 3
    await page.mouse.click(box.x + 200, box.y + 200);
    await page.waitForTimeout(100);

    // 7. Press 'c' to close as polygon
    // If the bug exists: The active tool's handler (PolylineTool.onKeyDown) is missing.
    // The event bubbles. Global handler sees 'c' -> Switches to Circle Tool.
    // If fixed: PolylineTool.onKeyDown handles 'c' -> Closes as polygon. Tool remains 'Polyline'.
    await page.keyboard.press('c');

    // 8. Assertion
    // Check that we did NOT switch to Circle tool
    await expect(page.getByTestId('status-tool')).not.toContainText('Circle');

    // Consistency check: It should still be Polyline (since Polyline tool doesn't auto-deactivate on finish)
    await expect(page.getByTestId('status-tool')).toContainText('Polyline');
  });
});
