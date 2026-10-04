import { test, expect, type Page } from '@playwright/test';

/**
 * `ViewerCell` rebuilds its Fabric objects from state asynchronously: it clears
 * the canvas, awaits every object, then adds them. A newer rebuild that starts
 * during that await, or an unmount, must stop the older one from adding.
 *
 * `viewer-cell.html` mounts one cell and exposes `window.__viewerCell`, so a
 * spec can start rebuilds within a single task and count what reaches the
 * canvas. Both dev apps serve the page, `apps/dev` for SolidJS and
 * `apps/dev-react` for React, and both run this spec (#152). Each `load` is its
 * own committed state change: Solid runs the effect synchronously on a store
 * write, and the React page wraps each write in `flushSync`.
 */

interface CanvasLike {
  getObjects(): { id?: unknown }[];
  add(...objects: unknown[]): number;
}
interface Harness {
  readonly framework: string;
  load(count: number, broken?: number, malformed?: number): void;
  readonly renderErrors: readonly string[];
  overlay: { canvas: CanvasLike } | undefined;
  unmount(): void;
}
type HarnessWindow = Window & { __viewerCell?: Harness; __addedAfterUnmount?: number };

/**
 * Opens the harness page and waits for the cell's overlay. Fails if the page
 * belongs to the other binding than this config's `metadata.framework`, or if
 * the config does not say, so a run can never pass by testing the wrong app.
 */
async function openHarness(page: Page, query = ''): Promise<void> {
  await page.goto(`/viewer-cell.html${query}`);
  await page.waitForFunction(() => (window as HarnessWindow).__viewerCell?.overlay !== undefined);
  const expected: unknown = test.info().config.metadata['framework'];
  expect(expected, 'the Playwright config must set metadata.framework').toEqual(expect.any(String));
  expect(await page.evaluate(() => (window as HarnessWindow).__viewerCell!.framework)).toBe(
    expected,
  );
}

/** Ids of the annotation objects on the cell's canvas, sorted. */
const canvasAnnotationIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const canvas = (window as HarnessWindow).__viewerCell!.overlay!.canvas;
    return canvas
      .getObjects()
      .map((obj) => obj.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();
  });

/**
 * Waits long enough for every rebuild started so far to have resolved. That is
 * an assumption, not a guarantee: Fabric enlivens from in-memory data, so the
 * promises settle within microtasks, and this leaves a wide margin. A rebuild
 * still pending afterwards could only make a test pass falsely, never fail.
 */
const settle = (page: Page): Promise<void> => page.waitForTimeout(500);

test.describe('ViewerCell annotation rebuild', () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  test('a superseded rebuild does not add its objects (#160)', async ({ page }) => {
    // The first rebuild clears and starts loading two rectangles; the second
    // clears a still-empty canvas and loads one. Without cancellation both
    // add, leaving three objects for one annotation in state.
    await page.evaluate(() => {
      const harness = (window as HarnessWindow).__viewerCell!;
      harness.load(2);
      harness.load(1);
    });
    // Wait for the first add, then for every rebuild to land, and only then
    // compare: a stale rebuild shows up as extra ids here, straight away.
    await expect.poll(async () => (await canvasAnnotationIds(page)).length).toBeGreaterThan(0);
    await settle(page);
    expect(await canvasAnnotationIds(page)).toEqual(['rect-0']);
  });

  test('rebuilding the same annotations twice leaves one copy of each (#160)', async ({ page }) => {
    await page.evaluate(() => {
      const harness = (window as HarnessWindow).__viewerCell!;
      harness.load(2);
      harness.load(2);
    });
    // Wait for the first add, then for every rebuild to land, and only then
    // compare: a stale rebuild shows up as extra ids here, straight away.
    await expect.poll(async () => (await canvasAnnotationIds(page)).length).toBeGreaterThan(0);
    await settle(page);
    expect(await canvasAnnotationIds(page)).toEqual(['rect-0', 'rect-1']);
  });

  test('a rebuild in flight at unmount adds nothing to the destroyed canvas (#190)', async ({
    page,
  }) => {
    // First prove that a rebuild here does reach canvas.add, so the zero
    // below cannot come from a rebuild that never resolved.
    await page.evaluate(() => (window as HarnessWindow).__viewerCell!.load(3));
    await expect.poll(() => canvasAnnotationIds(page)).toEqual(['rect-0', 'rect-1', 'rect-2']);

    await page.evaluate(() => {
      const win = window as HarnessWindow;
      const harness = win.__viewerCell!;
      const canvas = harness.overlay!.canvas;
      const add = canvas.add.bind(canvas);
      let unmounted = false;
      win.__addedAfterUnmount = 0;
      canvas.add = (...objects: unknown[]) => {
        if (unmounted) win.__addedAfterUnmount! += objects.length;
        return add(...objects);
      };

      harness.load(3);
      harness.unmount();
      unmounted = true;
    });
    await expect(page.getByTestId('viewer-cell-host')).toHaveCount(0);
    await settle(page);
    expect(await page.evaluate(() => (window as HarnessWindow).__addedAfterUnmount)).toBe(0);
  });

  test('a rebuild that is not superseded still adds its objects', async ({ page }) => {
    // Control: cancellation must not swallow the rebuild that should win.
    await page.evaluate(() => (window as HarnessWindow).__viewerCell!.load(3));
    await expect.poll(() => canvasAnnotationIds(page)).toEqual(['rect-0', 'rect-1', 'rect-2']);
    await expect(page.locator('[data-annotation-count]')).toHaveAttribute(
      'data-annotation-count',
      '3',
    );
  });
});

/**
 * An annotation whose stored Fabric data cannot be revived must not take the
 * rest of the image's annotations down with it (#209). The page's `broken-<i>`
 * annotations name a Fabric class that does not exist, and its `malformed-<i>`
 * polygons have no points, which Fabric's loader would otherwise drop silently.
 */
test.describe('ViewerCell annotation that cannot be rendered', () => {
  const renderErrors = (page: Page): Promise<readonly string[]> =>
    page.evaluate(() => [...(window as HarnessWindow).__viewerCell!.renderErrors]);

  test('is skipped and reported, and the others still render (#209)', async ({ page }) => {
    await openHarness(page);

    await page.evaluate(() => (window as HarnessWindow).__viewerCell!.load(2, 1));

    await expect.poll(() => canvasAnnotationIds(page)).toEqual(['rect-0', 'rect-1']);
    await expect.poll(() => renderErrors(page)).toEqual(['broken-0']);
    await expect(page.locator('[data-annotation-count]')).toHaveAttribute(
      'data-annotation-count',
      '2',
    );
  });

  test('is reported when its data is malformed, not dropped silently (#209)', async ({ page }) => {
    // A polygon with no points: Fabric knows the class, but its loader drops
    // the object without an error unless deserializeFabricObject surfaces it.
    await openHarness(page);

    await page.evaluate(() => (window as HarnessWindow).__viewerCell!.load(1, 0, 1));

    await expect.poll(() => canvasAnnotationIds(page)).toEqual(['rect-0']);
    await expect.poll(() => renderErrors(page)).toEqual(['malformed-0']);
  });

  test('is reported with a console warning when no handler is given', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await openHarness(page, '?errors=default');

    await page.evaluate(() => (window as HarnessWindow).__viewerCell!.load(1, 1));

    await expect.poll(() => canvasAnnotationIds(page)).toEqual(['rect-0']);
    await expect.poll(() => warnings.filter((text) => text.includes('"broken-0"')).length).toBe(1);
  });

  test('is not reported by a rebuild that was superseded', async ({ page }) => {
    // The first rebuild includes the broken annotation; the second, started in
    // the same task, does not. Only the rebuild that lands may report.
    await openHarness(page);

    await page.evaluate(() => {
      const harness = (window as HarnessWindow).__viewerCell!;
      harness.load(1, 1);
      harness.load(1);
    });

    await expect.poll(() => canvasAnnotationIds(page)).toEqual(['rect-0']);
    await settle(page);
    expect(await renderErrors(page)).toEqual([]);
  });
});
