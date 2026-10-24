import { expect, type Page } from '@playwright/test';

export interface HostEventRecord {
  readonly type: string;
  readonly count: number | null;
  readonly geometryTypes: readonly string[];
  readonly at: number;
}

/** Waits for the page's probe to see cell 0 interactive (image open + overlay attached). */
export async function waitInteractive(page: Page): Promise<number> {
  const handle = await page.waitForFunction(
    () => (window as unknown as { __interactive?: { interactiveAt: number } }).__interactive,
    undefined,
    { timeout: 30_000 },
  );
  const mark = (await handle.jsonValue()) as { interactiveAt: number };
  return mark.interactiveAt;
}

export function hostEvents(page: Page): Promise<HostEventRecord[]> {
  return page.evaluate(
    () => (window as unknown as { __hostEvents?: HostEventRecord[] }).__hostEvents ?? [],
  );
}

/** The Fabric upper canvas of cell 0. Playwright's CSS engine pierces open shadow roots. */
export function upperCanvas(page: Page) {
  return page.locator('canvas.upper-canvas').first();
}

/** Selects the rectangle tool and drags a rectangle across the middle of cell 0. */
export async function drawRectangle(page: Page, offset = 0): Promise<void> {
  await page.getByTestId('tool-rectangle').click();
  const box = await upperCanvas(page).boundingBox();
  expect(box, 'cell 0 has a Fabric canvas').not.toBeNull();
  const x0 = box!.x + box!.width * 0.3 + offset;
  const y0 = box!.y + box!.height * 0.3 + offset;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 60, y0 + 40, { steps: 4 });
  await page.mouse.move(x0 + 120, y0 + 80, { steps: 4 });
  await page.mouse.up();
}

/** Centre of the rectangle `drawRectangle(page, offset)` draws. */
export async function rectangleCentre(page: Page, offset = 0): Promise<{ x: number; y: number }> {
  const box = (await upperCanvas(page).boundingBox())!;
  return { x: box.x + box.width * 0.3 + offset + 60, y: box.y + box.height * 0.3 + offset + 40 };
}
