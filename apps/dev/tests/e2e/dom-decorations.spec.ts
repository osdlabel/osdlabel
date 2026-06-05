import { test, expect } from '@playwright/test';

test.describe('DOM decorations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  });

  test('renders an interactive DOM badge over a drawn annotation', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // No annotations yet → no badges.
    await expect(page.locator('[data-osdlabel-test="dom-badge"]')).toHaveCount(0);

    const lineButton = page.getByTestId('tool-line');
    await lineButton.click();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Draw one line.
    await page.mouse.move(box.x + 120, box.y + 140);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + 140, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // A DOM badge (framework-rendered button) is mounted into the decoration root.
    const badge = page.locator('[data-osdlabel-test="dom-badge"]');
    await expect(badge).toHaveCount(1);
    await expect(badge).toBeVisible();

    // The badge is interactive — clicking it logs to console and must NOT start
    // a pan/draw (the active tool stays unchanged, no new annotation created).
    const messages: string[] = [];
    page.on('console', (msg) => messages.push(msg.text()));
    await badge.click();
    await page.waitForTimeout(100);
    expect(messages.some((m) => m.includes('DOM decoration clicked for'))).toBe(true);

    // Still exactly one annotation (the click did not draw a new line).
    await expect(page.locator('[data-osdlabel-test="dom-badge"]')).toHaveCount(1);
  });

  test('badge follows the image when the viewport pans', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    const lineButton = page.getByTestId('tool-line');
    await lineButton.click();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    await page.mouse.move(box.x + 120, box.y + 140);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + 140, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // The decoration root (positioned by the layer) carries the transform — not
    // the badge's immediate parent, which is the framework portal's wrapper.
    const root = page.locator('[data-osdlabel="decoration-dom"]').first();
    await expect(root).toBeVisible();
    const before = await root.evaluate((el) => (el as HTMLElement).style.transform);
    expect(before).toContain('translate3d');

    // Switch to navigate and pan the image; OSD fires its 'animation' sync,
    // which repositions the decoration root. Panning is deterministic (every
    // point shifts by the drag delta), unlike wheel-zoom against OSD.
    await page.getByTestId('tool-navigate').click();
    await page.mouse.move(box.x + 400, box.y + 320);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 220, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const after = await root.evaluate((el) => (el as HTMLElement).style.transform);
    expect(after).not.toBe(before);
  });
});
