import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * The stock `<Annotator>` toolbar bar at narrow host widths (#147).
 *
 * The bar is a flex row of `<Toolbar>`, `<GridControls>`, `<ViewControls>` and
 * `<ContextSwitcher>`. Without wrapping, its content (~710px) overflowed a
 * narrower host and the right-hand controls were clipped: not visible, and not
 * reachable, since the root does not scroll.
 */

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no layout box');
  return box;
};

/**
 * The two toolbar states worth covering. `<ViewControls>` is widest once a
 * cell shows an image whose view has been changed: that is when its Reset
 * button (and the separator before it) render. An empty grid never shows them.
 */
const STATES = [
  { name: 'an empty grid', prepare: async () => {} },
  {
    name: 'an image assigned and rotated',
    prepare: async (page: Page) => {
      await page.getByTestId('filmstrip-item-landscape').click();
      const rotate = page.getByTestId('view-rotate-cw');
      await expect(rotate).toBeEnabled({ timeout: 10000 });
      await rotate.click();
      await expect(page.getByTestId('view-reset')).toBeVisible();
    },
  },
] as const;

/**
 * Distinct rows among an element's rendered children, by vertical centre.
 * Every child (buttons, 1px separators, the `0.0` value labels) is centred on
 * its row by `align-items: center`, so one row shares one centre; the
 * tolerance only absorbs sub-pixel rounding.
 */
const countRows = (container: Locator): Promise<number> =>
  container.evaluate((el) => {
    const centres = [...el.children]
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => r.top + r.height / 2)
      .sort((a, b) => a - b);
    let rows = 0;
    let last = -Infinity;
    for (const c of centres) {
      if (c - last > 4) rows++;
      last = c;
    }
    return rows;
  });

for (const width of [560, 420]) {
  for (const state of STATES) {
    test(`every toolbar control stays inside a ${width}px annotator, with ${state.name}`, async ({
      page,
    }) => {
      await page.goto(`/annotator.html?width=${width}`);
      const root = page.getByTestId('annotator-root');
      await root.waitFor({ state: 'visible', timeout: 10000 });
      await state.prepare(page);

      const rootBox = await boxOf(root);
      // Sanity: the host actually constrained the annotator.
      expect(Math.round(rootBox.width)).toBe(width);

      // Every control in the bar (the root's first child) must lie inside the
      // root. The fullscreen toggle and the context switcher are the rightmost,
      // and were the first to be clipped.
      const controls = page.locator(
        '[data-testid="annotator-root"] > div:first-child :is(button, select, input)',
      );
      const count = await controls.count();
      expect(count).toBeGreaterThan(10);
      await expect(page.getByTestId('view-fullscreen')).toBeVisible();
      await expect(page.getByTestId('grid-selector-trigger')).toBeVisible();
      for (let i = 0; i < count; i++) {
        const control = controls.nth(i);
        if (!(await control.isVisible())) continue;
        const box = await boxOf(control);
        expect(box.x).toBeGreaterThanOrEqual(rootBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(rootBox.x + rootBox.width);
      }

      // Nothing in the bar may overflow the root horizontally.
      const overflow = await root.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBe(0);

      // The checks above also pass if only <ViewControls> wraps: a bar that
      // does not wrap then squeezes it beside the tools into a tall column of
      // button groups. The bar's own wrap is what moves it onto a row of its
      // own, so it keeps (nearly) the full width: pin that too.
      const firstTool = await boxOf(page.locator('[data-testid^="tool-"]').first());
      const viewControls = page.getByTestId('view-rotate-ccw').locator('..');
      const viewBox = await boxOf(viewControls);
      expect(viewBox.y).toBeGreaterThanOrEqual(firstTool.y + firstTool.height);
      const rows = await countRows(viewControls);
      expect(rows).toBeGreaterThanOrEqual(1);
      expect(rows).toBeLessThanOrEqual(2);
    });
  }
}

test('the toolbar stays on one row when there is room', async ({ page }) => {
  await page.goto('/annotator.html?width=1400');
  const root = page.getByTestId('annotator-root');
  await root.waitFor({ state: 'visible', timeout: 10000 });

  const fullscreen = await boxOf(page.getByTestId('view-fullscreen'));
  const firstTool = await boxOf(page.locator('[data-testid^="tool-"]').first());
  // Same row: vertical centres within a few pixels.
  expect(
    Math.abs(fullscreen.y + fullscreen.height / 2 - (firstTool.y + firstTool.height / 2)),
  ).toBeLessThanOrEqual(4);
});
