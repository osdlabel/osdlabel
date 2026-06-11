import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Validates that the Fabric `id` custom property is registered automatically
 * when a FabricOverlay mounts — and that the registration is idempotent across
 * many overlay constructions.
 *
 * Crucially, the dev harness (apps/dev/src/App.tsx) does NOT call
 * initFabricModule() itself, so everything asserted here is driven solely by the
 * library's auto-registration inside FabricOverlay's constructor.
 *
 * The harness exposes two test-only hooks on `window.__osdTest`:
 *   - serialize(): the current serialized annotation document
 *   - fabricCustomProperties(): a snapshot of FabricObject.customProperties
 *
 * Uses the bundled local image (`jpg`) so the test never depends on network
 * access to external DZI tile sources.
 */

interface SerializedAnnotation {
  readonly id: string;
  readonly rawAnnotationData: { readonly data: { readonly id?: string } };
}

interface OsdTestHooks {
  serialize: () => SerializedAnnotation[];
  fabricCustomProperties: () => string[];
}

function customProperties(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __osdTest: OsdTestHooks }).__osdTest.fabricCustomProperties(),
  );
}

function serializedAnnotations(page: Page): Promise<SerializedAnnotation[]> {
  return page.evaluate(() =>
    (window as unknown as { __osdTest: OsdTestHooks }).__osdTest.serialize(),
  );
}

/** Assign the local `jpg` image to the currently-active cell and wait for its overlay. */
async function assignLocalImageToActiveCell(page: Page): Promise<void> {
  const canvasCountBefore = await page.locator('canvas.upper-canvas').count();
  await page.getByTestId('filmstrip-item-jpg').click();
  // Wait until a(nother) Fabric overlay canvas has mounted.
  await expect
    .poll(() => page.locator('canvas.upper-canvas').count(), { timeout: 15000 })
    .toBeGreaterThan(canvasCountBefore - 1);
  await page.locator('canvas.upper-canvas').first().waitFor({ state: 'attached', timeout: 15000 });
}

async function drawRectangleInFirstCell(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const canvas = page.locator('canvas.upper-canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');

  const rect = page.getByTestId('tool-rectangle');
  await expect(rect).toBeEnabled({ timeout: 10000 });
  await rect.click();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe('Auto-registration of the Fabric `id` property', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Switch to the unscoped "General" context so the local image is in scope and
    // the rectangle tool is enabled (the default "Fracture" context is scoped to
    // the network DZI images only).
    await page.getByRole('combobox').selectOption({ label: 'General' });
    // Cell 0 defaults to a network DZI; assign the local image so the overlay
    // mounts offline. Its FabricOverlay constructor runs auto-init.
    await assignLocalImageToActiveCell(page);
    await page.waitForTimeout(500);
  });

  test('registers `id` automatically — no manual initFabricModule() call', async ({ page }) => {
    // The overlay mounted on load; auto-init must have registered exactly `id`.
    expect(await customProperties(page)).toEqual(['id']);
  });

  test('a drawn annotation serializes its id end-to-end', async ({ page }) => {
    await drawRectangleInFirstCell(page, { x: 140, y: 120 }, { x: 320, y: 240 });

    const anns = await serializedAnnotations(page);
    expect(anns).toHaveLength(1);

    const ann = anns[0]!;
    // The id survives toObject() only because the custom property is registered.
    expect(ann.id).toBeTruthy();
    expect(ann.rawAnnotationData.data.id).toBe(ann.id);
  });

  test('registration stays idempotent across many overlay constructions', async ({ page }) => {
    // Baseline: one overlay mounted, exactly one `id` entry.
    expect(await customProperties(page)).toEqual(['id']);

    // Draw in single-cell mode first so we have committed, serialized data.
    await drawRectangleInFirstCell(page, { x: 140, y: 120 }, { x: 300, y: 230 });
    const initial = await serializedAnnotations(page);
    expect(initial).toHaveLength(1);
    expect(initial[0]!.rawAnnotationData.data.id).toBe(initial[0]!.id);

    // Force MANY more overlay constructions: expand to a 2x2 grid and assign the
    // local image to all three remaining cells. Each assignment mounts a fresh
    // ViewerCell + FabricOverlay, re-running auto-init.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-2').click();
    await expect(page.getByTestId('grid-size')).toContainText('2x2');

    for (let i = 0; i < 3; i++) {
      await page.locator('text=Assign an image').first().click();
      await assignLocalImageToActiveCell(page);
    }
    await page.waitForTimeout(500);

    // After ≥4 overlay constructions, `customProperties` must still be exactly
    // ['id'] — not duplicated, not cleared. That is the idempotency guarantee.
    const props = await customProperties(page);
    expect(props).toEqual(['id']);
    expect(props.filter((p) => p === 'id')).toHaveLength(1);

    // Existing serialized data survived all the remounts with its id intact.
    const after = await serializedAnnotations(page);
    expect(after.length).toBeGreaterThanOrEqual(1);
    for (const ann of after) {
      expect(ann.rawAnnotationData.data.id).toBe(ann.id);
    }
    const ids = after.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
