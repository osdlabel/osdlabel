import { test, expect, type Page } from '@playwright/test';

/**
 * Drawing feedback for the polyline tool (issue #156): the in-progress preview
 * is drawn in the tool constraint's `defaultStyle`, and every clicked vertex is
 * marked so the close target is visible.
 *
 * Assertions read real rendered pixels off the Fabric canvas and real committed
 * state, rather than full-image snapshots — snapshots of a tiled OSD viewer are
 * not stable across engines, and this suite has to hold in CI's Chromium too.
 */

interface StoredAnnotation {
  geometry: { type: string; points?: { x: number; y: number }[] };
  rawAnnotationData: { data: { stroke?: string } };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

/** The 'General' context sets this on its polyline tool in the dev harness. */
const PREVIEW_COLOR = { r: 0, g: 229, b: 255 };

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/**
 * True when any pixel within `radius` CSS px of (x, y) is the preview colour.
 * A neighbourhood rather than a single pixel, so antialiasing on a 2px ring
 * stroke cannot flake the result.
 */
async function hasPreviewColorNear(page: Page, x: number, y: number, radius = 2): Promise<boolean> {
  return page.evaluate(
    ({ x, y, radius, color }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.lower-canvas');
      if (!canvas) throw new Error('lower canvas not found');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2d context not available');

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const cx = Math.round((x - rect.left) * scaleX);
      const cy = Math.round((y - rect.top) * scaleY);
      const span = Math.max(1, Math.round(radius * scaleX));

      const left = Math.max(0, cx - span);
      const top = Math.max(0, cy - span);
      const width = Math.min(canvas.width - left, span * 2 + 1);
      const height = Math.min(canvas.height - top, span * 2 + 1);
      if (width <= 0 || height <= 0) return false;

      const { data } = ctx.getImageData(left, top, width, height);
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3]!;
        if (alpha === 0) continue;
        // Generous per-channel tolerance: the marker is composited over image
        // pixels, so it never lands exactly on the nominal colour.
        if (
          Math.abs(data[i]! - color.r) < 60 &&
          Math.abs(data[i + 1]! - color.g) < 60 &&
          Math.abs(data[i + 2]! - color.b) < 60
        ) {
          return true;
        }
      }
      return false;
    },
    { x, y, radius, color: PREVIEW_COLOR },
  );
}

test.describe('Polyline drawing feedback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Bundled local image, so the viewer opens without network access.
    await page.getByTestId('filmstrip-item-jpg').click();
    await page.getByRole('combobox').selectOption({ label: 'General' });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.getByTestId('tool-polyline').click();
  });

  test('marks the first vertex with a ring in the configured style', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');

    const first = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 };
    await page.mouse.click(first.x, first.y);
    // Park the cursor to the right, so the rubber-band segment leaves the ring's
    // left side — sampled below — covered by the marker alone.
    await page.mouse.move(first.x + 220, first.y);
    await page.waitForTimeout(200);

    // On the ring (default first-vertex radius is 5 screen px)…
    expect(await hasPreviewColorNear(page, first.x - 5, first.y)).toBe(true);
    // …and not well outside it, which is what makes the above a ring and not
    // simply "the canvas is full of cyan".
    expect(await hasPreviewColorNear(page, first.x - 16, first.y)).toBe(false);
  });

  test('commits nothing until the path is finished', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.35);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.waitForTimeout(200);

    // The preview and its markers are chrome, never annotations.
    expect(await readAnnotations(page)).toHaveLength(0);
  });

  test('clicking the first vertex closes the path into a styled polygon', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');

    const first = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.35 };
    await page.mouse.click(first.x, first.y);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.35);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    // Within CLOSE_THRESHOLD_SCREEN_PX (10) of the first vertex.
    await page.mouse.move(first.x + 3, first.y + 3);
    await page.mouse.click(first.x + 3, first.y + 3);
    await page.waitForTimeout(300);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    const committed = annotations[0]!;
    expect(committed.geometry.type).toBe('polygon');
    expect(committed.geometry.points).toHaveLength(3);
    // The style that drove the preview is the style that gets committed.
    expect(committed.rawAnnotationData.data.stroke).toBe('#00e5ff');
  });

  test('the finish shortcut ends the path open, leaving a polyline', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.4);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
    // Enter (DEFAULT_KEYBOARD_SHORTCUTS.polylineFinish) ends the path open.
    // Note double click does NOT: PolylineTool tests `event.detail === 2`, but
    // the tool is driven from pointerdown, whose `detail` is 0 by spec, and OSD
    // preventDefault()s it so no compatibility mousedown/click is generated.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.geometry.type).toBe('polyline');
    expect(annotations[0]!.rawAnnotationData.data.stroke).toBe('#00e5ff');
  });

  test('cancelling clears the markers off the canvas', async ({ page }) => {
    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not found');

    const first = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 };
    await page.mouse.click(first.x, first.y);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
    await page.mouse.move(first.x + 220, first.y);
    await page.waitForTimeout(200);
    expect(await hasPreviewColorNear(page, first.x - 5, first.y)).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Preview and markers are gone, and nothing was committed in their place.
    expect(await hasPreviewColorNear(page, first.x - 5, first.y)).toBe(false);
    expect(await readAnnotations(page)).toHaveLength(0);
  });
});
