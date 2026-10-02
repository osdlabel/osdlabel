import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * The grid popover opens rightward from its button, so a button near a right
 * edge clipped it (#147). It now flips to open leftward when rightward would
 * be clipped — by a host container that hides overflow, or by the viewport.
 *
 * Driven through `grid-controls.html`, which mounts `<GridControls>` in a
 * fixed-width slot whose alignment and clipping the query string chooses.
 */

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no layout box');
  return box;
};

const open = async (page: Page, query: string) => {
  await page.goto(`/grid-controls.html?${query}`);
  await page.getByTestId('grid-selector-trigger').click();
  const popover = page.getByTestId('grid-selector-popover');
  await expect(popover).toBeVisible();
  return popover;
};

/** Every grid cell's box lies inside [left, right]. */
const expectCellsWithin = async (page: Page, left: number, right: number) => {
  const cells = page.locator('[data-testid^="grid-cell-"]');
  const count = await cells.count();
  // 6 columns x 4 rows in the harness.
  expect(count).toBe(24);
  for (let i = 0; i < count; i++) {
    const box = await boxOf(cells.nth(i));
    expect(box.x).toBeGreaterThanOrEqual(left);
    expect(box.x + box.width).toBeLessThanOrEqual(right);
  }
};

test('opens rightward when there is room', async ({ page }) => {
  const popover = await open(page, 'align=start');
  await expect(popover).toHaveAttribute('data-alignment', 'start');

  const trigger = await boxOf(page.getByTestId('grid-selector-trigger'));
  const box = await boxOf(popover);
  expect(Math.abs(box.x - trigger.x)).toBeLessThanOrEqual(1);
});

test('flips leftward at the right edge of a clipping container', async ({ page }) => {
  const popover = await open(page, 'align=end&clip=slot');
  await expect(popover).toHaveAttribute('data-alignment', 'end');

  const slot = await boxOf(page.getByTestId('grid-host-slot'));
  const trigger = await boxOf(page.getByTestId('grid-selector-trigger'));
  const box = await boxOf(popover);
  // Right edges line up, and the whole popover is inside the slot.
  expect(Math.abs(box.x + box.width - (trigger.x + trigger.width))).toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThanOrEqual(slot.x);
  expect(box.x + box.width).toBeLessThanOrEqual(slot.x + slot.width);
  await expectCellsWithin(page, slot.x, slot.x + slot.width);

  // And it is usable: the leftmost column, the part that used to be clipped
  // furthest from the button, takes a click.
  await page.getByTestId('grid-cell-1-2').click();
  await expect(page.getByTestId('grid-size')).toHaveText('1x2');
});

test('flips leftward at the right edge of the viewport', async ({ page }) => {
  // No clipping container: the slot sits against the window's right edge.
  const popover = await open(page, 'align=end&clip=viewport');
  await expect(popover).toHaveAttribute('data-alignment', 'end');

  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await boxOf(popover);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  await expectCellsWithin(page, 0, viewportWidth);
});

test('re-decides on every open', async ({ page }) => {
  // The alignment is measured each time the popover opens, not once: move the
  // button from the slot's right edge to its left between opens, and the
  // popover follows.
  const popover = await open(page, 'align=end&clip=slot');
  await expect(popover).toHaveAttribute('data-alignment', 'end');
  await page.getByTestId('grid-selector-trigger').click();
  await expect(popover).toHaveCount(0);

  await page
    .getByTestId('grid-host-slot')
    .evaluate((el) => ((el as HTMLElement).style.justifyContent = 'flex-start'));
  await page.getByTestId('grid-selector-trigger').click();
  await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
    'data-alignment',
    'start',
  );
});

test.describe('only elements that really clip the popover count', () => {
  // Each case wraps the control in something with hidden overflow that does
  // NOT clip it, with room to open rightward. A walk over plain ancestors
  // would see the hidden overflow and flip leftward for nothing.

  test('a fixed-position box escapes a clipping ancestor', async ({ page }) => {
    await page.goto('/grid-controls.html?align=start&clip=viewport');
    await page.getByTestId('grid-host-slot').evaluate((slot) => {
      const outer = slot.parentElement as HTMLElement;
      outer.style.overflow = 'hidden';
      outer.style.width = '200px';
      Object.assign((slot as HTMLElement).style, { position: 'fixed', left: '600px', top: '40px' });
    });
    await page.getByTestId('grid-selector-trigger').click();
    await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
      'data-alignment',
      'start',
    );
  });

  test('an absolutely positioned box escapes a static clipping ancestor', async ({ page }) => {
    await page.goto('/grid-controls.html?align=start&clip=viewport');
    await page.getByTestId('grid-host-slot').evaluate((slot) => {
      const outer = slot.parentElement as HTMLElement;
      // Static and clipping, so not the slot's containing block.
      outer.style.overflow = 'hidden';
      outer.style.width = '200px';
      Object.assign((slot as HTMLElement).style, {
        position: 'absolute',
        left: '600px',
        top: '40px',
      });
    });
    await page.getByTestId('grid-selector-trigger').click();
    await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
      'data-alignment',
      'start',
    );
  });

  test('a body whose overflow goes to the viewport does not clip', async ({ page }) => {
    // With the root's overflow visible, the body's overflow-x applies to the
    // viewport instead; the body box itself clips nothing.
    await page.goto('/grid-controls.html?align=end&clip=viewport');
    await page.evaluate(() => {
      document.body.style.overflowX = 'hidden';
      document.body.style.width = 'calc(100vw - 200px)';
    });
    await page.getByTestId('grid-selector-trigger').click();
    await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
      'data-alignment',
      'start',
    );
  });
});

test('the stock Annotator still opens it rightward', async ({ page }) => {
  // The button sits next to the tools at the bar's left, so nothing changes
  // for the common layout.
  await page.goto('/annotator.html?width=900');
  await page.getByTestId('grid-selector-trigger').click();
  await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
    'data-alignment',
    'start',
  );
});
