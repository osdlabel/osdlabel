import { test, expect, type Page } from '@playwright/test';

interface StoredAnnotation {
  geometry: { type: string; points?: { x: number; y: number }[] };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

/** Point counts of every polygon/polyline annotation currently in state. */
async function readPolyPointCounts(page: Page): Promise<number[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  const counts: number[] = [];
  for (const imageId of Object.keys(byImage)) {
    for (const id of Object.keys(byImage[imageId]!)) {
      const g = byImage[imageId]![id]!.geometry;
      if ((g.type === 'polygon' || g.type === 'polyline') && g.points) {
        counts.push(g.points.length);
      }
    }
  }
  return counts;
}

test.describe('Polygon vertex editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Load the bundled local image so the viewer opens without network access.
    await page.getByTestId('filmstrip-item-jpg').click();
    // "General" context (index 2) includes the polyline tool.
    await page.selectOption('select', { index: 2 });
    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  test('long-press to edit, then insert and delete vertices', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');
    const X = (n: number) => box.x + n;
    const Y = (n: number) => box.y + n;

    // Draw a 4-vertex square polygon, closing on the first vertex.
    await page.getByTestId('tool-polyline').click();
    const verts: [number, number][] = [
      [200, 200],
      [320, 200],
      [320, 320],
      [200, 320],
    ];
    for (const [x, y] of verts) {
      await page.mouse.click(X(x), Y(y));
      await page.waitForTimeout(150);
    }
    // Click near the first vertex (within the close threshold) to finish closed.
    await page.mouse.click(X(202), Y(202));
    await page.waitForTimeout(400);

    expect(await readPolyPointCounts(page)).toEqual([4]);

    // Enter vertex-edit mode with a long-press on the polygon body.
    await page.getByTestId('tool-select').click();
    await page.mouse.move(X(260), Y(260));
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Insert a vertex by dragging the top-edge midpoint handle (260, 200).
    await page.mouse.move(X(260), Y(200));
    await page.mouse.down();
    await page.mouse.move(X(260), Y(150), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect(await readPolyPointCounts(page)).toEqual([5]);

    // Delete a vertex: press a vertex control, then Backspace.
    await page.mouse.click(X(320), Y(320));
    await page.waitForTimeout(200);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);

    expect(await readPolyPointCounts(page)).toEqual([4]);
  });
});
