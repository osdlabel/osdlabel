import type { CDPSession, Dialog, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';

interface StoredAnnotation {
  geometry: {
    type: string;
    pixelCount?: number;
    origin?: { x: number; y: number };
    width?: number;
    height?: number;
    downsample?: number;
  };
  toolType?: string;
  rawAnnotationData?: { format?: string; data?: Record<string, unknown> };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/** Alpha of the Fabric layer at a client point: only annotations draw there. */
function fabricAlphaAt(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.lower-canvas');
      if (!canvas) throw new Error('no lower canvas');
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const sx = Math.round((px - rect.left) * scale);
      const sy = Math.round((py - rect.top) * scale);
      return ctx.getImageData(sx, sy, 1, 1).data[3] ?? 0;
    },
    [x, y] as const,
  );
}

/** Where an image-space point is on the page, through the overlay's flip-aware mapping. */
function imageToClient(page: Page, point: { x: number; y: number }) {
  return page.evaluate((pt) => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdOverlay?: { imageToScreen(p: { x: number; y: number }): { x: number; y: number } };
        })
      | null;
    if (!el?.__osdOverlay) throw new Error('test hooks not installed');
    const rect = el.getBoundingClientRect();
    const screen = el.__osdOverlay.imageToScreen(pt);
    return { x: rect.left + screen.x, y: rect.top + screen.y };
  }, point);
}

/**
 * Zooms the active viewer onto an image point at once, so that one image pixel
 * spans several screen pixels and a probe a pixel inside an edge cannot be
 * rounded onto it.
 */
async function zoomOnto(page: Page, point: { x: number; y: number }, zoom: number): Promise<void> {
  await page.evaluate(
    ([pt, z]) => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & {
            __osdViewer?: {
              viewport: {
                imageToViewportCoordinates(x: number, y: number): unknown;
                zoomTo(zoom: number, ref: unknown, immediately: boolean): void;
                panTo(center: unknown, immediately: boolean): void;
              };
            };
          })
        | null;
      const viewport = el?.__osdViewer?.viewport;
      if (!viewport) throw new Error('test hooks not installed');
      const center = viewport.imageToViewportCoordinates(pt.x, pt.y);
      viewport.zoomTo(z, center, true);
      viewport.panTo(center, true);
    },
    [point, zoom] as const,
  );
  await page.waitForTimeout(300);
}

/**
 * Zooms the active viewer onto an image point at once, at `screenPerImage`
 * screen pixels to an image pixel — what decides the grid a stroke on a
 * downsampled mask paints on.
 */
async function zoomToImageScale(
  page: Page,
  point: { x: number; y: number },
  screenPerImage: number | null,
): Promise<void> {
  await page.evaluate(
    ([pt, scale]) => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & {
            __osdViewer?: {
              viewport: {
                imageToViewportCoordinates(x: number, y: number): unknown;
                imageToViewportZoom(imageZoom: number): number;
                getMinZoom(): number;
                zoomTo(zoom: number, ref: unknown, immediately: boolean): void;
                panTo(center: unknown, immediately: boolean): void;
                applyConstraints(immediately: boolean): void;
              };
            };
          })
        | null;
      const viewport = el?.__osdViewer?.viewport;
      if (!viewport) throw new Error('test hooks not installed');
      const center = viewport.imageToViewportCoordinates(pt.x, pt.y);
      // `null` asks for the farthest out the viewer allows. Anything past its
      // limits springs back on the next interaction, so the view the stroke
      // is pressed in would depend on timing; settle it now instead.
      const zoom = scale === null ? viewport.getMinZoom() : viewport.imageToViewportZoom(scale);
      viewport.zoomTo(zoom, center, true);
      viewport.panTo(center, true);
      viewport.applyConstraints(true);
    },
    [point, screenPerImage] as const,
  );
  await page.waitForTimeout(300);
}

/** Image pixels per screen pixel in the active cell, as the overlay maps them. */
function imagePerScreen(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: { canvas: { getZoom(): number } } })
      | null;
    if (!el?.__osdOverlay) throw new Error('test hooks not installed');
    return 1 / el.__osdOverlay.canvas.getZoom();
  });
}

/** Unsigned LEB128 run lengths, base64'd: the canonical payload's `counts`. */
function canonicalCounts(runs: readonly number[]): string {
  const bytes: number[] = [];
  for (let n of runs) {
    while (n >= 0x80) {
      bytes.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    bytes.push(n);
  }
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A document holding one canonical mask at downsample 4 on `landscape.png`
 * (1280x800): a solid block of 30x20 cells covering image pixels
 * [240, 360) x [160, 240), well left of the image's centre so a horizontal
 * flip moves it.
 */
const COARSE_BOX = { x: 240, y: 160, width: 120, height: 80 } as const;
const COARSE_DOC = [
  {
    id: 'coarse-mask',
    imageId: 'landscape',
    contextId: 'ctx-3',
    toolType: 'segmentationBrush',
    geometry: {
      type: 'mask',
      origin: { x: COARSE_BOX.x, y: COARSE_BOX.y },
      width: COARSE_BOX.width,
      height: COARSE_BOX.height,
      pixelCount: COARSE_BOX.width * COARSE_BOX.height,
      downsample: 4,
    },
    rawAnnotationData: {
      format: 'osdlabel-mask',
      data: {
        ...COARSE_BOX,
        imageWidth: 1280,
        imageHeight: 800,
        counts: canonicalCounts([0, 30 * 20]),
        downsample: 4,
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** The same block at downsample 2: 60 x 40 cells. */
const COARSE2_DOC = [
  {
    ...COARSE_DOC[0]!,
    id: 'coarse-mask-2',
    geometry: { ...COARSE_DOC[0]!.geometry, downsample: 2 },
    rawAnnotationData: {
      format: 'osdlabel-mask',
      data: {
        ...COARSE_DOC[0]!.rawAnnotationData.data,
        counts: canonicalCounts([0, 60 * 40]),
        downsample: 2,
      },
    },
  },
];

/**
 * Loads a document through the demo's Import JSON panel, and fails unless it
 * loaded cleanly.
 *
 * Both demos report a refused document, and any skipped annotation, with
 * `alert()` and leave state as it was. Playwright dismisses dialogs unseen, so
 * without these checks a re-import that was rejected outright left the old
 * state in place and passed every assertion made about it.
 */
async function importDocument(page: Page, doc: unknown): Promise<void> {
  const dialogs: string[] = [];
  const onDialog = (dialog: Dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  };
  page.on('dialog', onDialog);
  try {
    await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
    const input = page.getByPlaceholder('Paste exported JSON here...');
    await input.fill(JSON.stringify(doc));
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    // The panel closes only after `loadAnnotations` ran; a refused import
    // raises a dialog and leaves it open. Wait for either, and report the
    // dialog's text first, so a refusal fails with its reason rather than as
    // a five-second timeout on the panel.
    await expect
      .poll(async () => dialogs.length > 0 || !(await input.isVisible()), { timeout: 10_000 })
      .toBe(true);
    expect(dialogs, 'the import raised a dialog').toEqual([]);
    await expect(input).toBeHidden();
    await page.waitForTimeout(300);
  } finally {
    page.off('dialog', onDialog);
  }
}

/** Empties the annotation state, so a re-import cannot pass by leaving it unchanged. */
async function clearAnnotations(page: Page): Promise<void> {
  await importDocument(page, []);
  expect(await readAnnotations(page)).toHaveLength(0);
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

    // And it reads back as the same mask, into empty state.
    const [before] = await readAnnotations(page);
    await clearAnnotations(page);
    await importDocument(page, doc);
    const [after] = await readAnnotations(page);
    expect(after?.rawAnnotationData?.format).toBe('osdlabel-mask');
    expect(after?.geometry.downsample).toBe(before?.geometry.downsample);
    expect(after?.geometry.pixelCount).toBe(before?.geometry.pixelCount);
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

  test('dims the other masks while one is selected', async ({ page }) => {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');

    const alphaAt = (x: number, y: number) => fabricAlphaAt(page, x, y);

    await page.getByTestId('tool-segmentationBrush').click();
    // Mask A, then let go of it; mask B stays selected after its stroke.
    await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const aAlone = await alphaAt(box.x + 230, box.y + 160);
    expect(aAlone).toBeGreaterThan(60);

    await stroke(page, { x: box.x + 200, y: box.y + 220 }, { x: box.x + 260, y: box.y + 220 });
    expect(await readAnnotations(page)).toHaveLength(2);
    await page.waitForTimeout(200);

    // Nothing marks a selected mask otherwise — it has no handles — so the
    // selection shows by the others fading. B keeps its full alpha; A drops to
    // the default 40% of it.
    const aDimmed = await alphaAt(box.x + 230, box.y + 160);
    const bSelected = await alphaAt(box.x + 230, box.y + 220);
    expect(bSelected).toBeGreaterThan(60);
    expect(aDimmed).toBeLessThan(bSelected * 0.6);

    // Deselecting restores it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await alphaAt(box.x + 230, box.y + 160)).toBe(aAlone);
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

  /**
   * The one mask there must be, as a test of whether a page point lies on it:
   * within its bounding box, widened by far more than a brush radius and far
   * less than the distance to the resting hand.
   */
  async function onlyMask(
    page: Page,
  ): Promise<(point: { x: number; y: number }) => Promise<boolean>> {
    const masks = await readAnnotations(page);
    expect(masks).toHaveLength(1);
    const g = masks[0]!.geometry;
    expect(g.origin).toBeDefined();
    const box = { x: g.origin!.x, y: g.origin!.y, w: g.width ?? 0, h: g.height ?? 0 };
    const margin = 30;
    return async (point) => {
      const p = await clientToImage(page, point);
      return (
        p.x >= box.x - margin &&
        p.x <= box.x + box.w + margin &&
        p.y >= box.y - margin &&
        p.y <= box.y + box.h + margin
      );
    };
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

    const onMask = await onlyMask(page);
    // The pencil's stroke is all there...
    expect(await onMask(start)).toBe(true);
    expect(await onMask(end)).toBe(true);
    // ...and the palm, well to the right and below it, is not.
    expect(await onMask(palm)).toBe(false);
  });

  test('a finger resting on the image while the mouse paints leaves no dot', async ({ page }) => {
    // A touch never wins over a mouse either. A finger left on a touchscreen
    // while the other hand paints with the mouse is not cancelled by the
    // platform: it lifts, after the stroke. The mouse's press takes the
    // stroke over from it. Before, the mouse was held instead: its whole
    // stroke was swallowed, and the finger's lift committed a dot.
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    const { touch } = await tabletInput(page);
    await page.getByTestId('tool-segmentationBrush').click();

    const finger = { x: box.x + 380, y: box.y + 280, id: 7 };
    const start = { x: box.x + 150, y: box.y + 200 };
    const end = { x: box.x + 220, y: box.y + 200 };
    await touch('touchStart', [finger]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    await touch('touchEnd', []);
    await page.waitForTimeout(200);

    const onMask = await onlyMask(page);
    // The mouse's stroke is all there...
    expect(await onMask(start)).toBe(true);
    expect(await onMask(end)).toBe(true);
    // ...and the finger, well to the right and below it, is not.
    expect(await onMask(finger)).toBe(false);
  });

  test.describe('a mask at downsample 4', () => {
    const inside = { x: 300, y: 200 };
    // Inside the last cell column (356..359), and just past it.
    const lastColumn = { x: 357, y: 200 };
    const pastIt = { x: 366, y: 200 };

    test('imports, and draws where its cells are', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]!.geometry).toMatchObject({ ...COARSE_DOC[0]!.geometry });

      const at = async (p: { x: number; y: number }) => {
        const client = await imageToClient(page, p);
        return fabricAlphaAt(page, client.x, client.y);
      };
      expect(await at(inside)).toBeGreaterThan(60);
      expect(await at(lastColumn)).toBeGreaterThan(60);
      expect(await at(pastIt)).toBe(0);
      expect(await at({ x: 300, y: 150 })).toBe(0);
    });

    test('draws every edge where its cells end, on both axes', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      // Close in, so a cell is several screen pixels across.
      await zoomOnto(page, inside, 4);
      const at = async (p: { x: number; y: number }) => {
        const client = await imageToClient(page, p);
        return fabricAlphaAt(page, client.x, client.y);
      };
      // A quarter-cell inside and half a cell outside each edge of the
      // [240, 360) x [160, 240) box. Probes half a cell in and a whole cell
      // out let a half-cell shift, or a one-cell overrun at the right or
      // bottom edge, pass; these fail both, checked by editing the renderer.
      for (const [name, insidePoint, outsidePoint] of [
        ['left', { x: 241, y: 200 }, { x: 238, y: 200 }],
        ['right', { x: 359, y: 200 }, { x: 362, y: 200 }],
        ['top', { x: 300, y: 161 }, { x: 300, y: 158 }],
        ['bottom', { x: 300, y: 239 }, { x: 300, y: 242 }],
      ] as const) {
        expect(await at(insidePoint), `inside the ${name} edge`).toBeGreaterThan(60);
        expect(await at(outsidePoint), `outside the ${name} edge`).toBe(0);
      }
    });

    test('draws where its cells are under a horizontal flip', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      const unflipped = await imageToClient(page, inside);
      expect(await fabricAlphaAt(page, unflipped.x, unflipped.y)).toBeGreaterThan(60);

      await page.getByTestId('view-flip-h').click();
      await page.waitForTimeout(300);

      // The mirror moved the mask: what was its screen position is now the
      // right half of the image, and the flip-aware mapping finds it again.
      expect(await fabricAlphaAt(page, unflipped.x, unflipped.y)).toBe(0);
      for (const p of [inside, lastColumn]) {
        const client = await imageToClient(page, p);
        expect(await fabricAlphaAt(page, client.x, client.y)).toBeGreaterThan(60);
      }
      const past = await imageToClient(page, pastIt);
      expect(await fabricAlphaAt(page, past.x, past.y)).toBe(0);
    });

    /** Selects the imported mask, then takes the brush, so a stroke refines it. */
    async function refineCoarse(page: Page): Promise<void> {
      await page.getByTestId('tool-select').click();
      const click = await imageToClient(page, inside);
      await page.mouse.click(click.x, click.y);
      await page.waitForTimeout(200);
      await page.getByTestId('tool-segmentationBrush').click();
    }

    test('zoomed out as far as the viewer goes, a d=2 mask keeps its grid', async ({ page }) => {
      await importDocument(page, COARSE2_DOC);
      await zoomToImageScale(page, inside, null);
      // This viewer stops at under three image pixels a screen pixel: nothing
      // finer than d=2 is shown, so a stroke paints at the mask's own grid.
      expect(await imagePerScreen(page)).toBeGreaterThanOrEqual(2);
      await refineCoarse(page);
      const from = await imageToClient(page, { x: 340, y: 200 });
      const to = await imageToClient(page, { x: 450, y: 200 });
      await stroke(page, from, to);

      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      const { geometry, rawAnnotationData } = annotations[0]!;
      expect(geometry.downsample).toBe(2);
      expect(rawAnnotationData?.data?.['downsample']).toBe(2);
      // Grew to the right, still on the 2-pixel grid.
      expect(geometry.origin).toEqual({ x: COARSE_BOX.x, y: COARSE_BOX.y });
      expect(geometry.width!).toBeGreaterThan(COARSE_BOX.width + 60);
      expect(geometry.width! % 2).toBe(0);
      expect(geometry.pixelCount!).toBeGreaterThan(COARSE_BOX.width * COARSE_BOX.height);
      expect(geometry.pixelCount! % 4).toBe(0);
    });

    test('zoomed out, a d=4 mask re-grids only as finely as the view shows', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      await zoomToImageScale(page, inside, null);
      // The finest power of two the view shows, read from the overlay rather
      // than assumed: the viewer's limits depend on its size.
      const perScreen = await imagePerScreen(page);
      let expected = 1;
      while (expected * 2 <= perScreen * (1 + 1e-9) && expected < 4) expected *= 2;
      expect(expected).toBeGreaterThan(1);
      await refineCoarse(page);
      const from = await imageToClient(page, { x: 340, y: 200 });
      const to = await imageToClient(page, { x: 450, y: 200 });
      await stroke(page, from, to);

      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      const { geometry } = annotations[0]!;
      expect(geometry.downsample).toBe(expected);
      expect(geometry.origin).toEqual({ x: COARSE_BOX.x, y: COARSE_BOX.y });
      expect(geometry.width!).toBeGreaterThan(COARSE_BOX.width + 60);
    });

    test('a stroke made closer in re-grids it finer, losing nothing', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      // An image pixel to a screen pixel: the stroke paints at d=1.
      await zoomToImageScale(page, inside, 1);
      await refineCoarse(page);
      const from = await imageToClient(page, { x: 340, y: 200 });
      const to = await imageToClient(page, { x: 450, y: 200 });
      await stroke(page, from, to);

      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      const { geometry, rawAnnotationData } = annotations[0]!;
      // d=1 is never written.
      expect(geometry.downsample).toBeUndefined();
      expect(rawAnnotationData?.data?.['downsample']).toBeUndefined();
      expect(geometry.origin).toEqual({ x: COARSE_BOX.x, y: COARSE_BOX.y });
      // Every pixel of the old block is still there, and the stroke added more.
      expect(geometry.width!).toBeGreaterThan(COARSE_BOX.width + 60);
      expect(geometry.pixelCount!).toBeGreaterThan(COARSE_BOX.width * COARSE_BOX.height);
      const corner = await imageToClient(page, { x: COARSE_BOX.x + 1, y: COARSE_BOX.y + 1 });
      expect(await fabricAlphaAt(page, corner.x, corner.y)).toBeGreaterThan(60);
    });

    test('a COCO export comes back at downsample 4', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      await page.getByTestId('export-coco').click();
      const exported = JSON.parse(await page.getByTestId('exported-json').inputValue()) as {
        geometry: { downsample?: number };
        rawAnnotationData: { format: string };
      }[];
      expect(exported[0]!.rawAnnotationData.format).toBe('coco-rle');
      // COCO's runs are image pixels; the geometry is what carries the factor.
      expect(exported[0]!.geometry.downsample).toBe(4);

      await clearAnnotations(page);
      await importDocument(page, exported);
      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]!.geometry).toEqual(COARSE_DOC[0]!.geometry);
      expect(annotations[0]!.rawAnnotationData).toEqual(COARSE_DOC[0]!.rawAnnotationData);
    });

    test('the canonical export round-trips', async ({ page }) => {
      await importDocument(page, COARSE_DOC);
      await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
      const exported = JSON.parse(await page.getByTestId('exported-json').inputValue()) as {
        id: string;
        geometry: unknown;
        rawAnnotationData: unknown;
      }[];
      expect(exported).toHaveLength(1);
      expect(exported[0]!.geometry).toEqual(COARSE_DOC[0]!.geometry);
      expect(exported[0]!.rawAnnotationData).toEqual(COARSE_DOC[0]!.rawAnnotationData);

      // And reading the export back gives the same state.
      const before = await page.getByTestId('annotations-json').textContent();
      await clearAnnotations(page);
      await importDocument(page, exported);
      expect(await page.getByTestId('annotations-json').textContent()).toBe(before);
    });
  });

  test.describe('New mask', () => {
    const boxOf = (a: StoredAnnotation) => ({
      x: a.geometry.origin!.x,
      y: a.geometry.origin!.y,
      w: a.geometry.width!,
      h: a.geometry.height!,
    });
    const newMask = (page: Page) => page.getByTestId('brush-new-mask');

    test('the button makes the next stroke a second mask', async ({ page }) => {
      const box = await page.locator('canvas.upper-canvas').boundingBox();
      if (!box) throw new Error('canvas not found');
      await page.getByTestId('tool-segmentationBrush').click();
      // Nothing selected: the next stroke creates, and the button says so.
      await expect(newMask(page)).toHaveAttribute('aria-pressed', 'true');

      await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });
      expect(await readAnnotations(page)).toHaveLength(1);
      // The new mask is selected, so the next stroke would refine it.
      await expect(newMask(page)).toHaveAttribute('aria-pressed', 'false');

      await newMask(page).click();
      await expect(newMask(page)).toHaveAttribute('aria-pressed', 'true');
      // Still the brush.
      await expect(page.getByTestId('brush-eraser')).toBeVisible();
      await stroke(page, { x: box.x + 200, y: box.y + 240 }, { x: box.x + 260, y: box.y + 240 });
      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(2);
      expect(annotations.every((a) => (a.geometry.pixelCount ?? 0) > 0)).toBe(true);
    });

    test('the n key does the same, and keeps the brush', async ({ page }) => {
      const box = await page.locator('canvas.upper-canvas').boundingBox();
      if (!box) throw new Error('canvas not found');
      await page.getByTestId('tool-segmentationBrush').click();
      await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });
      await expect(newMask(page)).toHaveAttribute('aria-pressed', 'false');

      await page.keyboard.press('n');
      await expect(newMask(page)).toHaveAttribute('aria-pressed', 'true');
      // A second press does not leave the brush, as a second Escape would.
      await page.keyboard.press('n');
      await expect(page.getByTestId('brush-eraser')).toBeVisible();

      await stroke(page, { x: box.x + 200, y: box.y + 240 }, { x: box.x + 260, y: box.y + 240 });
      expect(await readAnnotations(page)).toHaveLength(2);
    });

    test('a stroke over the first mask after New mask makes an overlapping one', async ({
      page,
    }) => {
      const box = await page.locator('canvas.upper-canvas').boundingBox();
      if (!box) throw new Error('canvas not found');
      await page.getByTestId('tool-segmentationBrush').click();
      const from = { x: box.x + 200, y: box.y + 160 };
      const to = { x: box.x + 260, y: box.y + 160 };
      await stroke(page, from, to);
      const [first] = await readAnnotations(page);

      await newMask(page).click();
      await stroke(page, from, to);
      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(2);
      // The first is untouched; the second covers the same ground.
      const again = annotations.find((a) => boxOf(a).x === boxOf(first!).x && a !== annotations[1]);
      expect(again?.geometry.pixelCount).toBe(first!.geometry.pixelCount);
      const [a, b] = annotations.map(boxOf);
      expect(a!.x < b!.x + b!.w && b!.x < a!.x + a!.w).toBe(true);
      expect(a!.y < b!.y + b!.h && b!.y < a!.y + a!.h).toBe(true);
    });

    test('is disabled in a one-mask context once the mask exists', async ({ page }) => {
      const box = await page.locator('canvas.upper-canvas').boundingBox();
      if (!box) throw new Error('canvas not found');
      await page.getByRole('combobox').selectOption({ label: 'Single mask' });
      await page.getByTestId('tool-segmentationBrush').click();
      await expect(newMask(page)).toBeEnabled();

      await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 260, y: box.y + 160 });
      expect(await readAnnotations(page)).toHaveLength(1);
      await expect(newMask(page)).toBeDisabled();
      await expect(newMask(page)).toHaveAttribute('title', /limit of 1 masks is reached/);

      // At the limit the key does nothing, like the button: the mask stays
      // selected and the brush stays the active tool.
      const [first] = await readAnnotations(page);
      await page.keyboard.press('n');
      await expect(page.getByTestId('brush-eraser')).toBeVisible();
      await expect(newMask(page)).toHaveAttribute('aria-pressed', 'false');
      // So the next stroke refines the one mask rather than being refused.
      await stroke(page, { x: box.x + 200, y: box.y + 240 }, { x: box.x + 260, y: box.y + 240 });
      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]!.geometry.pixelCount!).toBeGreaterThan(first!.geometry.pixelCount!);
    });

    test('pressed mid-stroke at the limit, keeps the stroke whole', async ({ page }) => {
      const box = await page.locator('canvas.upper-canvas').boundingBox();
      if (!box) throw new Error('canvas not found');
      await page.getByRole('combobox').selectOption({ label: 'Single mask' });
      await page.getByTestId('tool-segmentationBrush').click();
      await stroke(page, { x: box.x + 200, y: box.y + 160 }, { x: box.x + 220, y: box.y + 160 });
      const [first] = await readAnnotations(page);

      // A refining stroke with `n` pressed halfway: it used to deselect the
      // mask, switch the brush off and tear the stroke down unsaved.
      await page.mouse.move(box.x + 200, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 240, box.y + 200, { steps: 5 });
      await page.keyboard.press('n');
      await page.mouse.move(box.x + 300, box.y + 200, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(200);

      await expect(page.getByTestId('brush-eraser')).toBeVisible();
      const annotations = await readAnnotations(page);
      expect(annotations).toHaveLength(1);
      // The whole stroke landed: its 100 screen pixels, not the 40 before `n`.
      expect(annotations[0]!.geometry.width!).toBeGreaterThanOrEqual(100);
      expect(annotations[0]!.geometry.pixelCount!).toBeGreaterThan(first!.geometry.pixelCount!);
    });
  });
});

test.describe('Segmentation brush: coarsening on overflow', () => {
  // 256 x 256 cells, so a stroke that fits on screen reaches the cap.
  const CAP = 65_536;

  /** Opens the app under the low cap, on the landscape image, in `context`. */
  async function open(page: Page, context: string): Promise<void> {
    await page.goto(`/?brushMaxPixels=${CAP}`);
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    await page.getByTestId('filmstrip-item-landscape').click();
    await page.getByRole('combobox').selectOption({ label: context });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.getByTestId('tool-segmentationBrush').click();
  }

  /**
   * An L-shaped stroke in image pixels, (200, 200) to (600, 200) to
   * (600, 500): about 424 x 324 with the brush, 137 K cells at d=1, more than
   * twice the cap.
   */
  async function paintL(page: Page, modifiers: 'Alt'[] = []): Promise<void> {
    const a = await imageToClient(page, { x: 200, y: 200 });
    const b = await imageToClient(page, { x: 600, y: 200 });
    const c = await imageToClient(page, { x: 600, y: 500 });
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 30 });
    await page.mouse.move(c.x, c.y, { steps: 30 });
    await page.mouse.up();
    for (const key of modifiers) await page.keyboard.up(key);
    await page.waitForTimeout(300);
  }

  /** Cells a box of image pixels holds at downsample `d`, on that grid. */
  const cellsAt = (
    g: { origin?: { x: number; y: number }; width?: number; height?: number },
    d: number,
  ) => {
    const x = g.origin!.x;
    const y = g.origin!.y;
    return (
      (Math.ceil((x + g.width!) / d) - Math.floor(x / d)) *
      (Math.ceil((y + g.height!) / d) - Math.floor(y / d))
    );
  };

  test('a region past the cap commits coarsened, and says so', async ({ page }) => {
    await open(page, 'Brush (coarsen)');
    await expect(page.getByTestId('brush-coarsen-notice')).toHaveCount(0);
    await paintL(page);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    const { geometry } = annotations[0]!;
    const d = geometry.downsample ?? 1;
    // The coarsest grid the stroke needed, from its own box: it fits at d,
    // and would not have at d / 2.
    expect(d).toBeGreaterThan(1);
    expect(cellsAt(geometry, d)).toBeLessThanOrEqual(CAP);
    expect(cellsAt(geometry, d / 2)).toBeGreaterThan(CAP);
    // The far end of the stroke, painted after the coarsening, is there.
    const end = await imageToClient(page, { x: 600, y: 490 });
    expect(await fabricAlphaAt(page, end.x, end.y)).toBeGreaterThan(60);
    await expect(page.getByTestId('brush-coarsen-notice')).toHaveText(
      `The mask was coarsened from 1x to ${d}x to fit its cap.`,
    );
  });

  test('the same stroke is refused where the context does not coarsen', async ({ page }) => {
    await open(page, 'General');
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await paintL(page);
    expect(await readAnnotations(page)).toHaveLength(0);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatch(/^Stroke too large: Mask would need \d+ cells at downsample 1/);
    await expect(page.getByTestId('brush-coarsen-notice')).toHaveCount(0);
  });

  test('erased down, a stroke made closer in re-grids it to full resolution', async ({ page }) => {
    await open(page, 'Brush (coarsen)');
    await paintL(page);
    const coarse = (await readAnnotations(page))[0]!;
    expect(coarse.geometry.downsample).toBeGreaterThan(1);

    // A wide eraser along all but the start of the stroke leaves a small
    // mask: its box at d=1 now fits the cap.
    for (let i = 0; i < 4; i++) await page.keyboard.press(']');
    const from = await imageToClient(page, { x: 260, y: 200 });
    const corner = await imageToClient(page, { x: 600, y: 200 });
    const end = await imageToClient(page, { x: 600, y: 520 });
    await page.keyboard.down('Alt');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(corner.x, corner.y, { steps: 30 });
    await page.mouse.move(end.x, end.y, { steps: 30 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForTimeout(300);
    for (let i = 0; i < 4; i++) await page.keyboard.press('[');
    const erased = (await readAnnotations(page))[0]!;
    expect(erased.geometry.width!).toBeLessThan(120);
    expect(erased.geometry.downsample).toBe(coarse.geometry.downsample);

    // At an image pixel a screen pixel, the next stroke paints at d=1.
    await zoomToImageScale(page, { x: 220, y: 200 }, 1);
    const a = await imageToClient(page, { x: 210, y: 200 });
    const b = await imageToClient(page, { x: 240, y: 230 });
    await stroke(page, a, b);
    const fine = (await readAnnotations(page))[0]!;
    expect(fine.geometry.downsample).toBeUndefined();
    expect(fine.geometry.pixelCount!).toBeGreaterThan(erased.geometry.pixelCount!);
  });
});
