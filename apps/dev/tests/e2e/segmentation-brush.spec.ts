import type { CDPSession, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';

interface StoredAnnotation {
  geometry: { type: string; pixelCount?: number; origin?: { x: number; y: number } };
  toolType?: string;
  rawAnnotationData?: { format?: string };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/** Drags a short stroke across the canvas, sampling a few intermediate points. */
async function stroke(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: 'Alt'[] = [],
): Promise<void> {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
  await page.waitForTimeout(200);
}

test.describe('Segmentation brush', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // A committed sample image, so the suite runs offline (#144).
    await page.getByTestId('filmstrip-item-landscape').click();
    // The "General" context is the one that includes the brush.
    await page.getByRole('combobox').selectOption({ label: 'General' });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
  });

  test('painting commits a mask annotation with painted pixels', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.geometry.type).toBe('mask');
    expect(annotations[0]?.toolType).toBe('segmentationBrush');
    expect(annotations[0]?.rawAnnotationData?.format).toBe('osdlabel-mask');
    expect(annotations[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(0);
  });

  test('a second stroke refines the same mask rather than creating another', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 240, y: box.y + 160 });
    const first = await readAnnotations(page);
    expect(first).toHaveLength(1);

    await stroke(page, { x: box.x + 200, y: box.y + 200 }, { x: box.x + 240, y: box.y + 200 });
    const second = await readAnnotations(page);

    // Still one annotation, now covering more pixels.
    expect(second).toHaveLength(1);
    expect(second[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(first[0]?.geometry.pixelCount ?? 0);
  });

  test('Alt-dragging erases from the mask', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 300, y: box.y + 160 });
    const painted = await readAnnotations(page);
    const paintedCount = painted[0]?.geometry.pixelCount ?? 0;
    expect(paintedCount).toBeGreaterThan(0);

    await stroke(page, { x: box.x + 240, y: box.y + 160 }, { x: box.x + 280, y: box.y + 160 }, [
      'Alt',
    ]);

    const erased = await readAnnotations(page);
    expect(erased).toHaveLength(1);
    expect(erased[0]?.geometry.pixelCount ?? 0).toBeLessThan(paintedCount);
  });

  test('painting over an existing shape paints, and does not drag it', async ({ page }) => {
    const box = (await page.locator('canvas.upper-canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Draw a rectangle, then paint straight across it. With the canvas in
    // ordinary annotation mode the stroke grabbed and moved the rectangle, and
    // `object:modified` persisted the move — silent corruption of an
    // annotation the user was not even editing.
    await page.getByTestId('tool-rectangle').click();
    await stroke(page, { x: cx - 120, y: cy - 100 }, { x: cx + 120, y: cy + 100 });

    const rectBefore = (await readAnnotations(page)).find((a) => a.geometry.type === 'rectangle');
    expect(rectBefore).toBeDefined();
    const originBefore = JSON.stringify(rectBefore!.geometry.origin);

    await page.getByTestId('tool-segmentationBrush').click();

    // Two strokes, deliberately. The first commits, which clears and rebuilds
    // the annotation layer — and the rebuild used to hand every object its
    // interactivity back, silently undoing paint mode. A single-stroke test
    // passes against that bug; the second stroke is the one that catches it.
    await stroke(page, { x: cx - 350, y: cy + 220 }, { x: cx - 250, y: cy + 220 });
    expect((await readAnnotations(page)).filter((a) => a.geometry.type === 'mask')).toHaveLength(1);

    await stroke(page, { x: cx - 100, y: cy }, { x: cx + 100, y: cy });

    const after = await readAnnotations(page);
    const rectAfter = after.find((a) => a.geometry.type === 'rectangle');
    expect(JSON.stringify(rectAfter!.geometry.origin)).toBe(originBefore);

    const masks = after.filter((a) => a.geometry.type === 'mask');
    expect(masks[0]!.geometry.pixelCount).toBeGreaterThan(0);
  });

  test('the toolbar exposes brush radius while the brush is active', async ({ page }) => {
    await expect(page.getByTestId('brush-radius')).toHaveCount(0);

    await page.getByTestId('tool-segmentationBrush').click();
    const radius = page.getByTestId('brush-radius');
    await expect(radius).toBeVisible();

    await radius.fill('30');
    await expect(page.getByTestId('brush-radius-value')).toHaveText('30px');
  });

  test('exports painted masks as COCO RLE from the demo toolbar', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 250, y: box.y + 160 });

    await page.getByTestId('export-coco').click();
    const exported = await page.getByTestId('exported-json').inputValue();
    const doc = JSON.parse(exported) as {
      rawAnnotationData: { format: string; data: { size: number[]; counts: string } };
    }[];

    expect(doc).toHaveLength(1);
    expect(doc[0]?.rawAnnotationData.format).toBe('coco-rle');
    // COCO reports [height, width] of the full image, and counts is the
    // compressed run-length string.
    expect(doc[0]?.rawAnnotationData.data.size).toHaveLength(2);
    expect(doc[0]?.rawAnnotationData.data.counts.length).toBeGreaterThan(0);
  });

  test('Delete removes the mask the brush just committed', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });
    expect(await readAnnotations(page)).toHaveLength(1);

    // The committed mask is the selected annotation, but `paint` mode keeps
    // every object inert, so Fabric has nothing selected. The tool must let
    // the key through to the host's keyboard map rather than swallow it.
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    expect(await readAnnotations(page)).toHaveLength(0);
  });

  test('resizing the brush mid-stroke keeps the stroke', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    await page.getByTestId('tool-segmentationBrush').click();

    // Resizing while painting is a routine gesture. It must not tear the tool
    // down: `deactivate()` cancels the open stroke, and everything painted so
    // far would be discarded with no feedback.
    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 160, { steps: 5 });
    await page.keyboard.press(']');
    await page.mouse.move(box.x + 280, box.y + 160, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(0);
  });

  test('a second finger resting mid-stroke ends the stroke instead of losing it', async ({
    page,
  }) => {
    // OSD reports a release only when its contact count returns to zero, so a
    // palm or thumb landing while the painting finger lifts left the stroke
    // open: the pixels were lost at the next press, and the brush was dead
    // while the second finger rested. The overlay now forwards the release.
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const touch = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      points: { x: number; y: number; id: number }[],
    ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

    await page.getByTestId('tool-segmentationBrush').click();
    const f1 = { x: box.x + 200, y: box.y + 160, id: 1 };
    const palm = { x: box.x + 360, y: box.y + 260, id: 2 };
    await touch('touchStart', [f1]);
    await touch('touchMove', [{ ...f1, x: f1.x + 30 }]);
    await touch('touchMove', [{ ...f1, x: f1.x + 60 }]);
    // The palm lands, then the painting finger lifts while it rests.
    await touch('touchStart', [{ ...f1, x: f1.x + 60 }, palm]);
    await touch('touchEnd', [palm]);
    await touch('touchEnd', []);
    await page.waitForTimeout(200);

    const after = await readAnnotations(page);
    expect(after).toHaveLength(1);
    expect(after[0]?.geometry.pixelCount ?? 0).toBeGreaterThan(0);

    // And the brush is alive: the next clean stroke paints a second mask.
    await page.keyboard.press('Escape');
    await touch('touchStart', [{ x: box.x + 200, y: box.y + 230, id: 3 }]);
    await touch('touchMove', [{ x: box.x + 240, y: box.y + 230, id: 3 }]);
    await touch('touchMove', [{ x: box.x + 270, y: box.y + 230, id: 3 }]);
    await touch('touchEnd', []);
    await page.waitForTimeout(200);
    expect(await readAnnotations(page)).toHaveLength(2);
  });

  test('a cancelled pointer discards its stroke, and hovering on does not paint', async ({
    page,
  }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    await page.getByTestId('tool-segmentationBrush').click();

    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 160, { steps: 5 });
    // The browser's cancel: OSD stops tracking the pointer and never reports a
    // release, and Fabric has no listener for it.
    await page.locator('canvas.upper-canvas').evaluate((el) => {
      el.dispatchEvent(
        new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true }),
      );
    });
    // The platform cancels a press it decided was not meant for the page
    // (palm rejection, a system gesture), so nothing is committed.
    await page.waitForTimeout(200);
    expect(await readAnnotations(page)).toHaveLength(0);

    // Hovering on afterwards (the button is up from the browser's view) must
    // not start painting either.
    await page.mouse.move(box.x + 320, box.y + 220, { steps: 5 });
    await page.mouse.move(box.x + 380, box.y + 160, { steps: 5 });
    await page.waitForTimeout(200);
    expect(await readAnnotations(page)).toHaveLength(0);
    await page.mouse.up();
  });

  /** Touch and pen, as an iPad delivers them: CDP touches, and pen mouse events. */
  async function tabletInput(page: Page) {
    const cdp: CDPSession = await page.context().newCDPSession(page);
    return {
      touch: (
        type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
        points: { x: number; y: number; id: number }[],
      ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points }),
      pen: (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number) =>
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: type === 'mouseMoved' ? 'none' : 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: 1,
          pointerType: 'pen',
        }),
    };
  }

  /**
   * A page point in image space, through the overlay the brush itself uses.
   * Converting where the stroke landed, rather than comparing two strokes'
   * geometry, keeps the check independent of the viewer's zoom.
   */
  async function clientToImage(page: Page, point: { x: number; y: number }) {
    return page.evaluate((pt) => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & {
            __osdOverlay?: { screenToImage(p: { x: number; y: number }): { x: number; y: number } };
          })
        | null;
      if (!el?.__osdOverlay) throw new Error('test hooks not installed');
      const rect = el.getBoundingClientRect();
      return el.__osdOverlay.screenToImage({ x: pt.x - rect.left, y: pt.y - rect.top });
    }, point);
  }

  test('a palm the platform rejects paints nothing', async ({ page }) => {
    // On an iPad the hand often rests before the pencil arrives, and iPadOS
    // cancels it a moment later. Committing on that cancel left a dot.
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    const { touch } = await tabletInput(page);
    await page.getByTestId('tool-segmentationBrush').click();

    const palm = { x: box.x + 360, y: box.y + 260, id: 7 };
    await touch('touchStart', [palm]);
    await touch('touchCancel', []);
    await page.waitForTimeout(200);
    expect(await readAnnotations(page)).toHaveLength(0);
  });

  test('a pencil landing before the palm is rejected paints alone', async ({ page }) => {
    // The other order of the same race: the pencil lands while the platform
    // has not yet cancelled the palm. The touch is the palm; the pencil's
    // stroke must arrive whole, and none of the palm with it.
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    const { touch, pen } = await tabletInput(page);
    await page.getByTestId('tool-segmentationBrush').click();

    const palm = { x: box.x + 380, y: box.y + 280, id: 7 };
    const start = { x: box.x + 150, y: box.y + 200 };
    const end = { x: box.x + 220, y: box.y + 200 };
    await touch('touchStart', [palm]);
    await pen('mousePressed', start.x, start.y);
    await pen('mouseMoved', start.x + 30, start.y);
    await touch('touchCancel', []);
    for (let x = start.x + 40; x <= end.x; x += 10) await pen('mouseMoved', x, start.y);
    await pen('mouseReleased', end.x, end.y);
    await page.waitForTimeout(200);

    const masks = await readAnnotations(page);
    expect(masks).toHaveLength(1);
    const g = masks[0]!.geometry as {
      origin?: { x: number; y: number };
      width?: number;
      height?: number;
    };
    expect(g.origin).toBeDefined();
    const box2 = { x: g.origin!.x, y: g.origin!.y, w: g.width ?? 0, h: g.height ?? 0 };
    // Generous: far more than a brush radius, far less than the palm's distance.
    const margin = 30;
    const inside = (p: { x: number; y: number }) =>
      p.x >= box2.x - margin &&
      p.x <= box2.x + box2.w + margin &&
      p.y >= box2.y - margin &&
      p.y <= box2.y + box2.h + margin;
    // The pencil's stroke is all there...
    expect(inside(await clientToImage(page, start))).toBe(true);
    expect(inside(await clientToImage(page, end))).toBe(true);
    // ...and the palm, well to the right and below it, is not.
    expect(inside(await clientToImage(page, palm))).toBe(false);
  });
});
