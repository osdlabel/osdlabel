import { test, expect, type Page } from '@playwright/test';

interface ViewState {
  readonly zoom: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly containerX: number;
  readonly containerY: number;
}

/** Reads OSD's viewport through the `testMode` hook on the OSD canvas. */
const readView = (page: Page): Promise<ViewState | null> =>
  page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdViewer?: {
            viewport?: {
              getZoom: (current?: boolean) => number;
              getCenter: (current?: boolean) => { x: number; y: number };
              getContainerSize: () => { x: number; y: number };
            };
          };
        })
      | null;
    const viewport = el?.__osdViewer?.viewport;
    if (!viewport) return null;
    const center = viewport.getCenter(false);
    const size = viewport.getContainerSize();
    return {
      zoom: viewport.getZoom(false),
      centerX: center.x,
      centerY: center.y,
      containerX: size.x,
      containerY: size.y,
    };
  });

/**
 * Whether the element that went fullscreen is the app's registered root rather
 * than the `documentElement` fallback — i.e. the dev app's
 * `fullscreenTargetRef` registration was picked up.
 */
const fullscreenRootIsTarget = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const el = document.fullscreenElement;
    if (!el || el === document.documentElement) return false;
    return el.querySelector('.openseadragon-canvas') !== null;
  });

test.describe('Fullscreen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.openseadragon-canvas');
    await page.getByTestId('filmstrip-item-jpg').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdViewer?: { isOpen?: () => boolean } })
        | null;
      return el?.__osdViewer?.isOpen?.() === true;
    });
  });

  test('the toggle enters and leaves fullscreen', async ({ page }) => {
    const button = page.getByTestId('view-fullscreen');
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // Must be a real click: requestFullscreen() requires a user gesture, so
    // driving it from page.evaluate() rejects with NotAllowedError.
    await button.click();

    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await fullscreenRootIsTarget(page)).toBe(true);

    await button.click();

    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  });

  test('Escape does not clear the active tool while fullscreen', async ({ page }) => {
    // The browser exits fullscreen on Escape and cannot be stopped, so the
    // annotator must not act on it too. Only the annotator's half is asserted
    // here: whether the UA actually leaves fullscreen is its own behaviour,
    // and headless Chromium has no window manager to do it.
    //
    // 'General' has no per-tool limits, so the rectangle shortcut is enabled.
    await page.getByRole('combobox').selectOption({ label: 'General' });

    await page.keyboard.press('r');
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');

    const button = page.getByTestId('view-fullscreen');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');

    // ...and the guard is conditional, not a blanket disable: once out of
    // fullscreen, Escape clears the tool again.
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-tool')).toContainText('Navigate');
  });

  test('the view returns exactly where it started after a round trip', async ({ page }) => {
    const before = await readView(page);
    expect(before).not.toBeNull();

    const button = page.getByTestId('view-fullscreen');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const during = await readView(page);

    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    const after = await readView(page);

    // Centre is preserved throughout — OSD scales around it rather than
    // re-fitting, which is what makes the round trip lossless.
    expect(during!.centerX).toBeCloseTo(before!.centerX, 6);
    expect(during!.centerY).toBeCloseTo(before!.centerY, 6);

    expect(after!.zoom).toBeCloseTo(before!.zoom, 6);
    expect(after!.centerX).toBeCloseTo(before!.centerX, 6);
    expect(after!.centerY).toBeCloseTo(before!.centerY, 6);
  });

  test('on-screen image scale follows the container diagonal', async ({ page }) => {
    const before = await readView(page);

    const button = page.getByTestId('view-fullscreen');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const during = await readView(page);

    // Only meaningful if the container actually changed size; headless
    // Chromium with an emulated viewport may keep it fixed.
    test.skip(
      during!.containerX === before!.containerX && during!.containerY === before!.containerY,
      'container size unchanged in this environment — nothing to compare',
    );

    const diagonalRatio =
      Math.hypot(during!.containerX, during!.containerY) /
      Math.hypot(before!.containerX, before!.containerY);
    const screenScaleRatio =
      (during!.containerX * during!.zoom) / (before!.containerX * before!.zoom);

    expect(screenScaleRatio).toBeCloseTo(diagonalRatio, 3);
  });
});
