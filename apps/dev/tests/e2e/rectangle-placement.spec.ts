import { test, expect } from './helpers/fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Fabric 7 positions an object by its centre unless an origin is set. A
 * rectangle placed by its first corner is therefore painted half its size up
 * and to the left of the drag, while its geometry still round-trips. Only the
 * painted pixels show it, so this reads them from Fabric's lower canvas, which
 * holds nothing but committed Fabric objects.
 */
async function alphaAt(page: Page, x: number, y: number): Promise<number> {
  return page.locator('canvas.lower-canvas').evaluate(
    (el, p) => {
      const canvas = el as HTMLCanvasElement;
      const scale = canvas.width / canvas.clientWidth;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('lower canvas has no 2d context');
      return ctx.getImageData(Math.round(p.x * scale), Math.round(p.y * scale), 1, 1).data[3]!;
    },
    { x, y },
  );
}

test.describe('Rectangle placement', () => {
  test('paints a drawn rectangle under the drag', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    await page.getByTestId('tool-rectangle').click();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const start = { x: 200, y: 160 };
    const end = { x: 360, y: 280 };
    await page.mouse.move(box.x + start.x, box.y + start.y);
    await page.mouse.down();
    await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // Inside the dragged box, near its far corner: painted.
    expect(await alphaAt(page, end.x - 12, end.y - 12)).toBeGreaterThan(0);
    // Up and to the left of the drag start, where a rectangle centred on its
    // first corner would reach: empty.
    expect(await alphaAt(page, start.x - 30, start.y - 30)).toBe(0);
  });
});
