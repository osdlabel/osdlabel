import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Cell-anchored ("HUD") decorations — issue #185.
 *
 * The dev app registers `lineRatioHudProvider`, which emits a single
 * `anchorSpace: 'cell'` text decoration (`id: 'hud:ratio'`) pinned to the
 * top-right of the cell once the image holds two or more line annotations.
 * The point of these tests is the *invariance* of that element: unlike every
 * other decoration in the app it must not move when the viewport pans, zooms,
 * rotates or flips — while still re-computing its text from live geometry.
 */

/**
 * Slack for "is pinned to the cell corner". The corner check measures against
 * the OSD canvas box — the element the decoration host is sized from — rather
 * than the grid cell, whose 2px active-cell border would otherwise have to be
 * folded into the budget. What is left is the provider's own 8px offset plus
 * the label's padding.
 */
const CORNER_TOLERANCE_PX = 12;
/** Slack for "did not move at all" comparisons of the same element across a view change. */
const STATIC_TOLERANCE_PX = 1;

const HUD_SELECTOR = '[data-decoration-id="hud:ratio"]';
/** Any decoration text element that is *not* the HUD — i.e. an image-anchored one. */
const IMAGE_TEXT_SELECTOR =
  '[data-osdlabel="decoration-text"]:not([data-decoration-id="hud:ratio"])';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no bounding box');
  return box;
};

const canvasBox = async (page: Page): Promise<Box> => {
  const canvas = page.locator('canvas.upper-canvas');
  await canvas.waitFor({ state: 'attached', timeout: 15000 });
  return boxOf(canvas);
};

/** Draw one line annotation with the line tool, in canvas-relative coordinates. */
const drawLine = async (
  page: Page,
  box: Box,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> => {
  await page.getByTestId('tool-line').click();
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
};

/**
 * Assert the HUD sits in the top-right of the cell's viewport, whatever its
 * current size is. `anchorSpace: 'cell'` anchors are fractions of the
 * decoration host, which spans the OSD canvas, so that box is the reference.
 */
const expectPinnedTopRight = async (page: Page): Promise<void> => {
  const view = await canvasBox(page);
  const hud = await boxOf(page.locator(HUD_SELECTOR));
  expect(Math.abs(view.x + view.width - (hud.x + hud.width))).toBeLessThanOrEqual(
    CORNER_TOLERANCE_PX,
  );
  expect(Math.abs(hud.y - view.y)).toBeLessThanOrEqual(CORNER_TOLERANCE_PX);
};

/**
 * The annotation id of the cell's currently selected Fabric object, or `null`.
 *
 * Read through the overlay handle the dev app publishes in `testMode` (the same
 * hook `resize-jitter.spec.ts` uses); a missing handle throws rather than
 * reporting "nothing selected", so a broken hook cannot silently satisfy a
 * negative assertion.
 */
const selectedAnnotationId = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdOverlay?: { canvas?: { getActiveObject: () => { id?: string } | null } };
        })
      | null;
    const canvas = el?.__osdOverlay?.canvas;
    if (!canvas) throw new Error('overlay test hook not installed');
    return canvas.getActiveObject()?.id ?? null;
  });

test.describe('Cell-anchored HUD decorations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  // E1
  test('appears only once two lines exist, pinned to the cell top-right', async ({ page }) => {
    const box = await canvasBox(page);
    const hud = page.locator(HUD_SELECTOR);

    // No annotations yet, and one line is still not enough (needs a ratio).
    await expect(hud).toHaveCount(0);
    await drawLine(page, box, [120, 140], [320, 140]);
    await expect(hud).toHaveCount(0);

    // Second line: length 200 vs length 100 → 2.00 / 0.50. The exact strings
    // are safe because the ratio is scale-invariant (whatever image-space
    // scale the viewport is at divides out) and both drawn lengths are whole
    // CSS pixels, so the quotient is exact before rounding to 2 decimals.
    await drawLine(page, box, [120, 240], [220, 240]);
    await expect(hud).toHaveCount(1);
    await expect(hud).toBeVisible();
    await expect(hud).toContainText('L1/L2 ratio: 2.00');
    await expect(hud).toContainText('L2/L1 ratio: 0.50');

    await expectPinnedTopRight(page);
  });

  // E2
  test('does not move when the viewport pans, while image-anchored labels do', async ({ page }) => {
    const box = await canvasBox(page);
    await drawLine(page, box, [120, 140], [320, 140]);
    await drawLine(page, box, [120, 240], [220, 240]);

    const hud = page.locator(HUD_SELECTOR);
    const imageLabel = page.locator(IMAGE_TEXT_SELECTOR).first();
    await expect(hud).toHaveCount(1);
    await expect(imageLabel).toBeVisible();

    const hudBefore = await boxOf(hud);
    const labelBefore = await boxOf(imageLabel);

    // Pan in navigate mode (OSD owns the input): every image pixel shifts by the
    // drag delta, so an image-anchored label must follow and the HUD must not.
    await page.getByTestId('tool-navigate').click();
    await page.mouse.move(box.x + 400, box.y + 320);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 220, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const hudAfter = await boxOf(hud);
    expect(Math.abs(hudAfter.x - hudBefore.x)).toBeLessThanOrEqual(STATIC_TOLERANCE_PX);
    expect(Math.abs(hudAfter.y - hudBefore.y)).toBeLessThanOrEqual(STATIC_TOLERANCE_PX);

    const labelAfter = await boxOf(imageLabel);
    const labelMoved =
      Math.abs(labelAfter.x - labelBefore.x) + Math.abs(labelAfter.y - labelBefore.y);
    expect(labelMoved).toBeGreaterThan(10);
  });

  // E3
  test('does not move when the view is rotated or flipped', async ({ page }) => {
    const box = await canvasBox(page);
    await drawLine(page, box, [120, 140], [320, 140]);
    await drawLine(page, box, [120, 240], [220, 240]);

    const hud = page.locator(HUD_SELECTOR);
    await expect(hud).toHaveCount(1);
    const before = await boxOf(hud);

    await page.getByTestId('view-rotate-cw').click();
    await page.waitForTimeout(800);
    const afterRotate = await boxOf(hud);
    expect(Math.abs(afterRotate.x - before.x)).toBeLessThanOrEqual(STATIC_TOLERANCE_PX);
    expect(Math.abs(afterRotate.y - before.y)).toBeLessThanOrEqual(STATIC_TOLERANCE_PX);

    await page.getByTestId('view-flip-h').click();
    await page.waitForTimeout(600);
    const afterFlip = await boxOf(hud);
    expect(Math.abs(afterFlip.x - before.x)).toBeLessThanOrEqual(STATIC_TOLERANCE_PX);
    expect(Math.abs(afterFlip.y - before.y)).toBeLessThanOrEqual(STATIC_TOLERANCE_PX);

    await expectPinnedTopRight(page);
  });

  // E4
  test('text updates live while a line is resized, and matches the committed value', async ({
    page,
  }) => {
    const box = await canvasBox(page);
    // A diagonal first line, so its bounding box (and therefore its corner
    // scaling control) has real extent to grab.
    await drawLine(page, box, [150, 150], [300, 300]);
    await drawLine(page, box, [150, 400], [350, 400]);

    const hud = page.locator(HUD_SELECTOR);
    await expect(hud).toHaveCount(1);
    const beforeDrag = await hud.textContent();
    expect(beforeDrag).toBeTruthy();

    // Select the diagonal line, then drag its bottom-right scaling control.
    // Scaling (not moving) is what changes the line's length — a translation
    // would leave the ratio identical and make this test vacuous.
    await page.getByTestId('tool-select').click();
    await page.mouse.click(box.x + 225, box.y + 225);
    await page.waitForTimeout(300);
    // Fail here, as "nothing got selected", if the click missed the line —
    // otherwise a missed click surfaces below as a bogus "the HUD never
    // updated" product failure.
    expect(await selectedAnnotationId(page)).not.toBeNull();

    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    for (const step of [330, 360, 390, 420]) {
      await page.mouse.move(box.x + step, box.y + step, { steps: 3 });
      await page.waitForTimeout(120);
    }
    // Read the live value while the pointer is still down: this is
    // `enableLiveDecorationUpdates` re-running the provider on `object:scaling`,
    // before any state commit has happened. Condition-driven rather than a
    // fixed sleep, since the update lands on the next animation frame.
    await expect.poll(() => hud.textContent(), { timeout: 2000 }).not.toBe(beforeDrag);
    const midDrag = await hud.textContent();
    expect(midDrag).toBeTruthy();

    await page.mouse.up();
    await page.waitForTimeout(500);

    // The committed value (recomputed from state on `object:modified`) equals
    // what the live overlay was already showing for the same geometry.
    expect(await hud.textContent()).toBe(midDrag);
  });

  // E5
  test('stays pinned to the cell corner across a viewport resize', async ({ page }) => {
    const box = await canvasBox(page);
    await drawLine(page, box, [120, 140], [320, 140]);
    await drawLine(page, box, [120, 240], [220, 240]);

    await expect(page.locator(HUD_SELECTOR)).toHaveCount(1);
    await expectPinnedTopRight(page);

    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForTimeout(800);
    await expectPinnedTopRight(page);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(800);
    await expectPinnedTopRight(page);
  });

  // E6
  test('disappears when a line is deleted and fewer than two remain', async ({ page }) => {
    const box = await canvasBox(page);
    await drawLine(page, box, [120, 140], [320, 140]);
    await drawLine(page, box, [120, 240], [220, 240]);

    const hud = page.locator(HUD_SELECTOR);
    await expect(hud).toHaveCount(1);

    await page.getByTestId('tool-select').click();
    await page.waitForTimeout(200);
    await page.mouse.click(box.x + 170, box.y + 240);
    await page.waitForTimeout(300);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(400);

    await expect(hud).toHaveCount(0);
  });
});
