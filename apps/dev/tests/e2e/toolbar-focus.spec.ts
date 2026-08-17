import { test, expect, type Page } from '@playwright/test';

/**
 * The annotator's keyboard shortcuts are global and its real focus context is
 * the image, so a click on toolbar chrome must not park focus on the button.
 * A focused button is re-activated by Enter and Space — and `Enter` is also the
 * polyline-finish binding, so finishing a shape would re-fire whichever control
 * was last clicked.
 */

const activeTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

const readRotation = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdViewer?: { viewport?: { getRotation: () => number } } })
      | null;
    return el?.__osdViewer?.viewport?.getRotation() ?? null;
  });

test.describe('Toolbar focus', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]');
    await page.getByTestId('filmstrip-item-jpg').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdViewer?: { isOpen?: () => boolean } })
        | null;
      return el?.__osdViewer?.isOpen?.() === true;
    });
  });

  test('clicking a view control does not park focus on it', async ({ page }) => {
    await page.getByTestId('view-rotate-cw').click();
    expect(await activeTestId(page)).not.toBe('view-rotate-cw');
  });

  test('clicking a tool button does not park focus on it', async ({ page }) => {
    await page.getByTestId('tool-navigate').click();
    expect(await activeTestId(page)).not.toBe('tool-navigate');
  });

  test('Enter after clicking rotate does not rotate again', async ({ page }) => {
    await page.getByTestId('view-rotate-cw').click();
    const afterClick = await readRotation(page);
    expect(afterClick).not.toBeNull();

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    expect(await readRotation(page)).toBe(afterClick);
  });

  test('Enter after clicking the fullscreen toggle does not leave fullscreen', async ({ page }) => {
    const button = page.getByTestId('view-fullscreen');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Enter');

    await expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  test('a focused button can still be activated from the keyboard', async ({ page }) => {
    // The fix suppresses focus on mouse press only. Anyone arriving by Tab must
    // still be able to focus a control and fire it with Enter.
    const button = page.getByTestId('view-rotate-cw');
    await button.focus();
    expect(await activeTestId(page)).toBe('view-rotate-cw');

    const before = await readRotation(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    expect(await readRotation(page)).not.toBe(before);
  });
});
