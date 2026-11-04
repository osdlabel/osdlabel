import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';

/**
 * The dev apps' opt-in query parameters for testing by hand at whole-slide
 * scale (`apps/dev/src/large-image.ts`): `?largeImage[=WxH]` adds a synthetic
 * deep-zoom image whose tiles are drawn in the page, and `?image=<url>` adds
 * any URL. These keep them opt-in, keep the synthetic image offline, and check
 * that the library maps image space correctly at that scale.
 */

const DEFAULT_IMAGES = [
  { id: 'landscape', label: 'Landscape' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'wide', label: 'Wide image' },
  { id: 'tiled', label: 'Tiled (DZI)' },
] as const;
const DEFAULT_IDS = DEFAULT_IMAGES.map((image) => image.id);

interface OsdTestHooks {
  __osdViewer?: {
    world: {
      getItemCount(): number;
      getItemAt(i: number): { getContentSize(): { x: number; y: number } };
    };
    drawer: { canvas: HTMLCanvasElement };
  };
  __osdOverlay?: { imageToScreen(p: { x: number; y: number }): { x: number; y: number } };
}

/** The filmstrip's image ids, in order. */
async function filmstripIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="filmstrip-item-"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace(/^filmstrip-item-/, ''));
}

/**
 * Requests that left the dev server's origin, and any for a synthetic tile's
 * cache key: those are never meant to be fetched, so one would mean OSD fell
 * back to its own downloader.
 */
function watchRequests(page: Page, baseURL: string): { external: string[]; synthetic: string[] } {
  const origin = new URL(baseURL).origin;
  const seen = { external: [] as string[], synthetic: [] as string[] };
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('osdlabel-synthetic:')) seen.synthetic.push(url);
    // data:, blob: and about: carry no host and never leave the page.
    else if (/^https?:/i.test(url) && !url.startsWith(origin)) seen.external.push(url);
  });
  return seen;
}

/** The content size of the image the (single) cell has open, or null before one opens. */
function openedSize(page: Page): Promise<{ width: number; height: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as (Element & OsdTestHooks) | null;
    const world = el?.__osdViewer?.world;
    if (!world || world.getItemCount() === 0) return null;
    const size = world.getItemAt(0).getContentSize();
    return { width: size.x, height: size.y };
  });
}

async function openFromFilmstrip(
  page: Page,
  id: string,
  size: { width: number; height: number },
): Promise<void> {
  await page.getByTestId(`filmstrip-item-${id}`).click();
  await expect
    .poll(() => openedSize(page), { timeout: 15_000, message: `${id} did not open` })
    .toEqual(size);
}

/**
 * Mean colour the viewer drew around an image point, read from OSD's own
 * drawing canvas (2D for both drawers; WebGL copies into it). Null while the
 * point is off the canvas.
 */
function drawnColourAt(
  page: Page,
  point: { x: number; y: number },
): Promise<{ r: number; g: number; b: number; a: number } | null> {
  return page.evaluate((pt) => {
    const el = document.querySelector('.openseadragon-canvas') as (Element & OsdTestHooks) | null;
    const canvas = el?.__osdViewer?.drawer.canvas;
    const overlay = el?.__osdOverlay;
    if (!el || !canvas || !overlay) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const screen = overlay.imageToScreen(pt);
    const rect = el.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.width / canvasRect.width;
    const cx = Math.round((rect.left + screen.x - canvasRect.left) * scale);
    const cy = Math.round((rect.top + screen.y - canvasRect.top) * scale);
    const half = 4;
    if (cx < half || cy < half || cx + half >= canvas.width || cy + half >= canvas.height) {
      return null;
    }
    const { data } = ctx.getImageData(cx - half, cy - half, 2 * half + 1, 2 * half + 1);
    const sum = { r: 0, g: 0, b: 0, a: 0 };
    for (let i = 0; i < data.length; i += 4) {
      sum.r += data[i]!;
      sum.g += data[i + 1]!;
      sum.b += data[i + 2]!;
      sum.a += data[i + 3]!;
    }
    const n = data.length / 4;
    return { r: sum.r / n, g: sum.g / n, b: sum.b / n, a: sum.a / n };
  }, point);
}

/** Where an image-space point is on the page, through the overlay's mapping. */
function imageToClient(page: Page, point: { x: number; y: number }) {
  return page.evaluate((pt) => {
    const el = document.querySelector('.openseadragon-canvas') as (Element & OsdTestHooks) | null;
    if (!el?.__osdOverlay) throw new Error('test hooks not installed');
    const rect = el.getBoundingClientRect();
    const screen = el.__osdOverlay.imageToScreen(pt);
    return { x: rect.left + screen.x, y: rect.top + screen.y };
  }, point);
}

interface StoredMask {
  geometry: {
    type: string;
    origin?: { x: number; y: number };
    width?: number;
    height?: number;
    downsample?: number;
  };
}

async function readAnnotations(page: Page): Promise<StoredMask[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as Record<string, Record<string, StoredMask>>;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

test.describe('Large-image query parameters', () => {
  test('without them the filmstrip is unchanged', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="filmstrip"]', { timeout: 10_000 });

    expect(await filmstripIds(page)).toEqual(DEFAULT_IDS);
    for (const { id, label } of DEFAULT_IMAGES) {
      await expect(page.getByTestId(`filmstrip-item-${id}`)).toContainText(label);
    }
  });

  test('?largeImage opens a 100,000 x 80,000 image drawn in the page, with no request', async ({
    page,
    baseURL,
  }) => {
    const requests = watchRequests(page, baseURL!);
    await page.goto('/?largeImage');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10_000 });

    expect(await filmstripIds(page)).toEqual([...DEFAULT_IDS, 'large']);
    await expect(page.getByTestId('filmstrip-item-large')).toContainText('Large (synthetic)');

    await openFromFilmstrip(page, 'large', { width: 100_000, height: 80_000 });

    // Tiles were drawn, where they belong: the colour field's hue follows image
    // x, so the left of the image draws red-orange (more red than blue) and the
    // right blue-violet. A blank, black or mirrored canvas fails one side.
    // Points sit between grid lines and clear of the labels.
    const left = { x: 15_500, y: 45_500 };
    const right = { x: 85_500, y: 45_500 };
    await expect
      .poll(
        async () => {
          const [l, r] = [await drawnColourAt(page, left), await drawnColourAt(page, right)];
          return (
            l !== null && r !== null && l.a > 250 && r.a > 250 && l.r > l.b + 40 && r.b > r.r + 40
          );
        },
        { timeout: 20_000, message: 'synthetic tiles were not drawn' },
      )
      .toBe(true);

    await page.waitForLoadState('networkidle');
    expect(requests.external).toEqual([]);
    expect(requests.synthetic).toEqual([]);
  });

  test('?largeImage=WxH sets the size, each side clamped', async ({ page }) => {
    await page.goto('/?largeImage=4096x2048');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10_000 });
    await openFromFilmstrip(page, 'large', { width: 4096, height: 2048 });

    await page.goto('/?largeImage=99999999x10');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10_000 });
    await openFromFilmstrip(page, 'large', { width: 1_048_576, height: 1_024 });
  });

  test('?image= adds a URL as is, before the synthetic image', async ({ page, baseURL }) => {
    const requests = watchRequests(page, baseURL!);
    // Local, so the suite stays offline (#144).
    await page.goto('/?image=./sample-data/tiled.dzi&largeImage=2048x2048');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10_000 });

    expect(await filmstripIds(page)).toEqual([...DEFAULT_IDS, 'url-1', 'large']);
    await expect(page.getByTestId('filmstrip-item-url-1')).toContainText('tiled.dzi');

    await openFromFilmstrip(page, 'url-1', { width: 800, height: 600 });
    await page.waitForLoadState('networkidle');
    expect(requests.external).toEqual([]);
  });

  test('a brush stroke on the whole large image commits in its image space', async ({ page }) => {
    await page.goto('/?largeImage');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10_000 });
    await openFromFilmstrip(page, 'large', { width: 100_000, height: 80_000 });
    await page.getByRole('combobox').selectOption({ label: 'General' });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForTimeout(500);

    // Zoomed out to the whole image (as it opens): about 100 image pixels a
    // screen pixel, so a stroke a few dozen screen pixels long spans thousands.
    const imagePerScreen = await page.evaluate(() => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdOverlay?: { canvas: { getZoom(): number } } })
        | null;
      if (!el?.__osdOverlay) throw new Error('test hooks not installed');
      return 1 / el.__osdOverlay.canvas.getZoom();
    });
    expect(imagePerScreen).toBeGreaterThan(50);

    await page.getByTestId('tool-segmentationBrush').click();
    const radius = 100;
    await page.getByTestId('brush-radius').fill(String(radius));
    await expect(page.getByTestId('brush-radius-value')).toHaveText(`${radius}px`);

    const from = { x: 50_000, y: 40_000 };
    const to = { x: 56_000, y: 40_000 };
    const start = await imageToClient(page, from);
    const end = await imageToClient(page, to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await readAnnotations(page)).length).toBe(1);
    const [mask] = await readAnnotations(page);
    expect(mask!.geometry.type).toBe('mask');
    // A new mask starts at full resolution whatever the zoom (an absent
    // `downsample` means 1).
    expect(mask!.geometry.downsample ?? 1).toBe(1);
    const origin = mask!.geometry.origin;
    expect(origin).toBeDefined();
    // Where the stroke was pressed, to within a couple of screen pixels: far
    // past anything the bundled images (2,000 px at most) could produce.
    const slack = 3 * imagePerScreen;
    expect(Math.abs(origin!.x - (from.x - radius))).toBeLessThanOrEqual(slack);
    expect(Math.abs(origin!.y - (from.y - radius))).toBeLessThanOrEqual(slack);
    expect(Math.abs(mask!.geometry.width! - (to.x - from.x + 2 * radius))).toBeLessThanOrEqual(
      2 * slack,
    );
  });
});
