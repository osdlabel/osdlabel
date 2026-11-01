/**
 * A press the platform cancels chooses no vertex for Delete to remove.
 *
 * In vertex-edit mode, Delete and Backspace remove the vertex last pressed,
 * and a press on an edge-insert handle presses the vertex it inserts. When the
 * platform cancels that press (`pointercancel`: palm rejection, an edge
 * swipe), `FabricOverlay` takes the inserted vertex back. Until the fix the
 * editor kept its key as the Delete target, and the key then named the
 * original vertex that slid back into that index: the next Delete removed
 * that vertex and stored the polygon without it, although no press had chosen
 * it. A cancelled press now leaves the target as the press found it.
 *
 * Touch through CDP, as in `touch-cancel.spec.ts`: `touchCancel` produces a
 * genuine `pointercancel`. The editor's half is pinned in fabric-annotations'
 * `poly-vertex-editor.test.ts`.
 */
import type { CDPSession, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import { touchLiftAll, touchPressAndDrag } from './helpers/touch.js';
import {
  annotationsText,
  expectPointClose,
  openAnnotator,
  readAnnotations,
  settle,
  type Point,
  type View,
} from './rectangle/helpers.js';

const FINGER = 1;

/** The platform takes the finger away: `pointercancel`, and no `pointerup`. */
async function touchCancel(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
}

async function touchTap(cdp: CDPSession, at: Point): Promise<void> {
  await touchPressAndDrag(cdp, FINGER, [at]);
  await touchLiftAll(cdp);
}

interface OverlayHost {
  readonly canvas: {
    getObjects(): readonly { readonly points?: readonly Point[] }[];
    getActiveObject(): { readonly oCoords?: Record<string, Point> } | null | undefined;
  };
}

/** The points of the one object on the overlay's canvas, as Fabric holds them now. */
async function livePoints(page: Page): Promise<Point[]> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHost })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const objects = overlay.canvas.getObjects();
    if (objects.length !== 1) throw new Error(`${objects.length} objects on the canvas, not 1`);
    return (objects[0]!.points ?? []).map(({ x, y }) => ({ x, y }));
  });
}

/** Where the selected object's control `key` is drawn, in page px. */
async function controlOnPage(page: Page, view: View, key: string): Promise<Point> {
  const at = await page.evaluate((k) => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: OverlayHost })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const point = overlay.canvas.getActiveObject()?.oCoords?.[k];
    if (!point) throw new Error(`no active object, or it has no ${k} control`);
    return { x: point.x, y: point.y };
  }, key);
  return { x: view.canvasOrigin.x + at.x, y: view.canvasOrigin.y + at.y };
}

/** The stored polygon's points, in image px. */
async function storedPoints(page: Page): Promise<readonly Point[]> {
  const all = await readAnnotations(page);
  expect(all, 'expected exactly one stored annotation').toHaveLength(1);
  const geometry = all[0]!.geometry as { readonly type: string; readonly points?: Point[] };
  expect(geometry.type).toBe('polygon');
  return geometry.points ?? [];
}

/**
 * Every edit rebuilds the polygon from its saved Fabric data, which
 * `toObject()` rounds to 4 decimals.
 */
const TOL = 0.01;

function expectPoints(actual: readonly Point[], expected: readonly Point[], what: string): void {
  expect(actual, `${what}: ${JSON.stringify(actual)}`).toHaveLength(expected.length);
  expected.forEach((p, i) => expectPointClose(actual[i]!, p, TOL, `${what}: p${i}`));
}

/**
 * A square polygon drawn with the mouse, then put in vertex-edit mode by a
 * long press with the select tool. Returns its stored points.
 */
async function squareInEditMode(
  page: Page,
): Promise<{ view: View; cdp: CDPSession; square: readonly Point[] }> {
  const view = await openAnnotator(page);
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number): Point => ({
    x: view.canvasOrigin.x + x,
    y: view.canvasOrigin.y + y,
  });

  // Closed by the last click, next to the first vertex.
  await page.getByTestId('tool-polyline').click();
  for (const [x, y] of [
    [200, 200],
    [320, 200],
    [320, 320],
    [200, 320],
    [202, 202],
  ] as const) {
    await page.mouse.click(at(x, y).x, at(x, y).y);
    await page.waitForTimeout(150);
  }
  await settle(page);
  const square = await storedPoints(page);
  expect(square).toHaveLength(4);

  // Not at the centroid, where the measurement label sits and would take the touch.
  await page.getByTestId('tool-select').click();
  await touchPressAndDrag(cdp, FINGER, [at(225, 295)]);
  await page.waitForTimeout(800);
  await touchLiftAll(cdp);
  await settle(page);
  // In vertex-edit mode: the polygon has its insert handles.
  await controlOnPage(page, view, 'ins0');
  return { view, cdp, square };
}

/** Press the insert handle of the first edge, and have the platform cancel the press. */
async function cancelledInsert(page: Page, view: View, cdp: CDPSession): Promise<void> {
  const before = await annotationsText(page);
  await touchPressAndDrag(cdp, FINGER, [await controlOnPage(page, view, 'ins0')]);
  // The press reached the handle: it inserted its vertex.
  await expect
    .poll(async () => (await livePoints(page)).length, { message: 'the press inserted nothing' })
    .toBe(5);

  await touchCancel(cdp);
  await settle(page);

  expect(await annotationsText(page), 'the cancelled press committed something').toBe(before);
  expect(await livePoints(page), 'the cancel did not take the vertex back').toHaveLength(4);
}

test.describe('Delete after a cancelled vertex-handle press', () => {
  test.use({ hasTouch: true });

  test('after a cancelled insert press, Delete removes no vertex', async ({ page }) => {
    const { view, cdp, square } = await squareInEditMode(page);
    await cancelledInsert(page, view, cdp);
    const before = await annotationsText(page);

    await page.keyboard.press('Delete');
    await settle(page);

    expect(await annotationsText(page), 'the Delete removed a vertex no press chose').toBe(before);
    expectPoints(await livePoints(page), square, 'on the canvas after the Delete');

    // Delete does reach the editor: with a vertex pressed, it removes that
    // one. So the empty result above means something.
    await touchTap(cdp, await controlOnPage(page, view, 'p3'));
    await settle(page);
    expect(await annotationsText(page), 'the tap on a vertex committed something').toBe(before);
    await page.keyboard.press('Delete');
    await settle(page, before);
    expectPoints(await storedPoints(page), square.slice(0, 3), 'stored after the second Delete');
  });

  test('the vertex pressed before a cancelled insert press stays the Delete target', async ({
    page,
  }) => {
    const { view, cdp, square } = await squareInEditMode(page);
    const before = await annotationsText(page);
    await touchTap(cdp, await controlOnPage(page, view, 'p3'));
    await settle(page);
    expect(await annotationsText(page), 'the tap on a vertex committed something').toBe(before);
    // Clear of the tap, so the two cannot pair as a double tap.
    await page.waitForTimeout(400);

    await cancelledInsert(page, view, cdp);
    await page.keyboard.press('Delete');
    await settle(page, before);

    expectPoints(await storedPoints(page), square.slice(0, 3), 'stored after the Delete');
    expectPoints(await livePoints(page), square.slice(0, 3), 'on the canvas after the Delete');
  });
});
