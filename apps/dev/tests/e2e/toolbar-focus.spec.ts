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
    await page.getByTestId('filmstrip-item-tiled').click();
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

  test('a press on the image takes focus off a Tab-focused tool button (#189)', async ({
    page,
  }) => {
    // The overlay prevents the default of every press it owns in annotation
    // mode, which also cancelled the browser's own focus change. A tool picked
    // from the keyboard kept focus while the user drew with the mouse, so a
    // later Enter went to the button: since Enter on a focused button belongs
    // to the button, the polyline was never finished.
    await page.getByRole('combobox').selectOption({ label: 'General' });
    const polyline = page.getByTestId('tool-polyline');
    await polyline.focus();
    await page.keyboard.press('Enter');
    expect(await activeTestId(page)).toBe('tool-polyline');

    const canvas = page.locator('canvas.upper-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no layout box');
    await page.mouse.click(box.x + 100, box.y + 100);

    // Focus moved to the viewer, as a native click on the image would do.
    expect(
      await page.evaluate(
        () => document.activeElement?.classList.contains('openseadragon-canvas') ?? false,
      ),
    ).toBe(true);

    await page.mouse.click(box.x + 200, box.y + 120);
    await page.mouse.click(box.x + 260, box.y + 200);
    await page.keyboard.press('Enter');

    // Enter finished the polyline rather than re-pressing the tool button.
    await expect
      .poll(async () => {
        const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
        const byImage = JSON.parse(text) as Record<string, Record<string, unknown>>;
        return Object.values(byImage).flatMap((forImage) => Object.keys(forImage)).length;
      })
      .toBe(1);
  });

  test('the press reaches Fabric before focus leaves a host control', async ({ page }) => {
    // Natively the focus change is the press's default action, so press
    // handlers run before any blur it causes. A host field that commits on
    // blur must not rebuild the canvas under a press Fabric has not seen yet.
    // 'General' offers the rectangle tool on the tiled image this suite loads.
    const select = page.getByRole('combobox');
    await select.selectOption({ label: 'General' });
    await page.getByTestId('tool-rectangle').click();
    await select.focus();

    await page.evaluate(() => {
      const order: string[] = [];
      (window as unknown as { __order: string[] }).__order = order;
      document.querySelector('select')!.addEventListener('blur', () => order.push('blur'));
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & {
            __osdOverlay?: { canvas?: { on: (name: string, cb: () => void) => void } };
          })
        | null;
      const canvas = el?.__osdOverlay?.canvas;
      if (!canvas) throw new Error('overlay test hook not installed');
      canvas.on('mouse:down', () => order.push('fabric-down'));
    });

    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas has no layout box');
    await page.mouse.click(box.x + 120, box.y + 120);

    expect(await page.evaluate(() => (window as unknown as { __order: string[] }).__order)).toEqual(
      ['fabric-down', 'blur'],
    );
  });
});
