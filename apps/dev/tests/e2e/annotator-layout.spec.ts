import { test, expect, type Locator } from '@playwright/test';

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

for (const width of [560, 420]) {
  test(`every toolbar control stays inside a ${width}px annotator`, async ({ page }) => {
    await page.goto(`/annotator.html?width=${width}`);
    const root = page.getByTestId('annotator-root');
    await root.waitFor({ state: 'visible', timeout: 10000 });

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

    // The checks above also pass if only <ViewControls> wraps: a bar that does
    // not wrap then squeezes it beside the tools into a tall column of button
    // groups. The bar's own wrap is what moves it onto a row of its own, so it
    // keeps (nearly) the full width: pin that too.
    const firstTool = await boxOf(page.locator('[data-testid^="tool-"]').first());
    const viewControls = page.getByTestId('view-rotate-ccw').locator('..');
    const viewBox = await boxOf(viewControls);
    expect(viewBox.y).toBeGreaterThanOrEqual(firstTool.y + firstTool.height);

    const rowCentres = await viewControls.locator(':scope > button').evaluateAll((buttons) =>
      buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      }),
    );
    expect(rowCentres.length).toBeGreaterThan(5);
    expect(new Set(rowCentres).size).toBeLessThanOrEqual(2);
  });
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
