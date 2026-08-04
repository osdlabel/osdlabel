import { test, expect } from '@playwright/test';

interface ZoomState {
  readonly zoom: number;
  readonly home: number;
  readonly min: number;
}

/**
 * Reads OSD's viewport zoom state through the `testMode` hook that
 * `FabricOverlay` installs on the OSD canvas container.
 */
const readZoom = (page: import('@playwright/test').Page): Promise<ZoomState | null> =>
  page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdViewer?: {
            viewport?: {
              getZoom: (current?: boolean) => number;
              getHomeZoom: () => number;
              getMinZoom: () => number;
            };
          };
        })
      | null;
    const viewport = el?.__osdViewer?.viewport;
    if (!viewport) return null;
    return {
      zoom: viewport.getZoom(false),
      home: viewport.getHomeZoom(),
      min: viewport.getMinZoom(),
    };
  });

test.describe('Viewer zoom', () => {
  test.beforeEach(async ({ page }) => {
    // A short, wide window makes the cell much wider than the 800x600 sample
    // image, so the image fits by HEIGHT and home zoom drops well below 1 —
    // the configuration that used to trip the absolute `minZoomLevel` floor.
    await page.setViewportSize({ width: 1500, height: 520 });
    await page.goto('/');
    await page.waitForSelector('.openseadragon-canvas');

    // Local JPG — no tile server needed.
    await page.getByTestId('filmstrip-item-jpg').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdViewer?: { isOpen?: () => boolean } })
        | null;
      return el?.__osdViewer?.isOpen?.() === true;
    });
  });

  test('the fit-the-image zoom stays reachable', async ({ page }) => {
    const state = await readZoom(page);
    expect(state).not.toBeNull();
    // Guard the premise: the cell is wide enough that the image fits by height.
    expect(state!.home).toBeLessThan(1);
    // The zoom-out floor must sit below home zoom, otherwise the user can
    // never fit the image again once OSD applies its constraints.
    expect(state!.min).toBeLessThan(state!.home);
  });

  test('a click in navigate mode does not zoom the image', async ({ page }) => {
    const before = await readZoom(page);
    expect(before).not.toBeNull();

    const box = await page.locator('.openseadragon-canvas').first().boundingBox();
    if (!box) throw new Error('viewer canvas not found');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    // Longer than OSD's animationTime (0.3s) so any zoom animation settles.
    await page.waitForTimeout(600);

    const after = await readZoom(page);
    expect(after!.zoom).toBeCloseTo(before!.zoom, 6);
  });

  test('zooming out after a click restores the fitted view', async ({ page }) => {
    const box = await page.locator('.openseadragon-canvas').first().boundingBox();
    if (!box) throw new Error('viewer canvas not found');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);

    // Zoom all the way out, then let OSD clamp to its own limits.
    await page.evaluate(() => {
      const el = document.querySelector('.openseadragon-canvas') as Element & {
        __osdViewer?: {
          viewport: {
            zoomTo: (zoom: number, ref: null, immediately: boolean) => void;
            applyConstraints: (immediately: boolean) => void;
          };
        };
      };
      el.__osdViewer?.viewport.zoomTo(0.0001, null, true);
      el.__osdViewer?.viewport.applyConstraints(true);
    });
    await page.waitForTimeout(600);

    const after = await readZoom(page);
    // The whole image fits again (zoomed out at least to home zoom).
    expect(after!.zoom).toBeLessThanOrEqual(after!.home);
  });
});
