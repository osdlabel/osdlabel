import { test, expect, type Page } from '@playwright/test';
import type { CDPSession } from '@playwright/test';

/**
 * Touch input in annotation mode (issue #175).
 *
 * `FabricOverlay` routes all input through an OSD `MouseTracker` on the Fabric
 * container and forwards each event to Fabric by dispatching a synthetic
 * `PointerEvent` on the upper canvas. That synthetic event bubbles back to the
 * container, so OSD's tracker processes one real press twice.
 * `GesturePointList.addContact()` corrects the double count **only for mouse
 * and pen**, leaving touch at `contacts === 2` — and `releaseHandler` fires
 * only at `contacts === 0`.
 *
 * The tests are in three tiers, and the split is deliberate:
 *
 * 1. **Symptom** — touch gestures that need a release do not work. These fail
 *    before the fix. Presses were always delivered, so anything committing on
 *    mousedown (selection) worked already; that case is a fence, not a
 *    symptom.
 * 2. **Mechanism** — the contact list is corrupted. These also fail before the
 *    fix, and they are what keeps a future change from suppressing the symptom
 *    while leaving the bookkeeping broken. A fix that makes tier 1 pass but not
 *    tier 2 has papered over the bug.
 * 3. **Regression fence** — things that work today and that a plausible fix
 *    would break. The candidate fixes all involve keeping the synthetic event
 *    out of the container, and Fabric moves its `pointerup` / `pointermove`
 *    listeners to the *document* after a mousedown, so suppressing the release
 *    as well as the press costs every gesture that commits on mouse-up. That
 *    is measured, not assumed: with `bubbles: false` on the whole event, both
 *    symptom tests fail too, because a rectangle is committed on the release
 *    exactly as a drag is. What these fences add over the symptom tier is the
 *    *mouse* path and navigation mode, neither of which the touch symptoms
 *    exercise.
 *
 * The rest of the fence lives in existing specs and is not duplicated here:
 * `polyline-drawing-feedback.spec.ts` covers the double-click finish, whose
 * detection runs in the same `releaseHandler` behind the same `_forwarding`
 * guard (#168); `dom-decorations.spec.ts` and `viewer-zoom.spec.ts` cover pan
 * and zoom in navigation mode, where input must still reach OSD untouched.
 * Run those alongside this file when changing the forwarding path.
 */

interface StoredAnnotation {
  geometry: { type: string; origin?: { x: number; y: number } };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/**
 * Drive a one-finger drag through CDP.
 *
 * Playwright's `page.touchscreen` can only tap, and a tap alone would not
 * exercise the move path. Chromium synthesises `PointerEvent`s with
 * `pointerType: 'touch'` from these, which is the path under test. Chromium
 * only — the suite runs no other browser.
 */
async function touchDrag(
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  // Two moves, so the gesture is unambiguously a drag rather than a jump.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: to.x, y: to.y, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Two taps close enough in time and space to pair as a double click. OSD's
 * MouseTracker thresholds are 300 ms and 20 px, and `_detectDoubleClick`
 * enforces the same, so this stays well inside both.
 */
async function touchDoubleTap(cdp: CDPSession, at: { x: number; y: number }): Promise<void> {
  await touchTap(cdp, at);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await touchTap(cdp, at);
}

async function touchTap(cdp: CDPSession, at: { x: number; y: number }): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Opens the app on the local tiled image with the all-tools context active. */
async function openAnnotator(page: Page): Promise<{ x: number; y: number }> {
  await page.goto('/');
  await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
  await page.getByTestId('filmstrip-item-tiled').click();
  // "General" permits every tool, so no constraint can mask a failure.
  await page.getByRole('combobox').selectOption({ label: 'General' });
  const canvas = page.locator('canvas.upper-canvas');
  await canvas.waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('upper canvas has no bounding box');
  return { x: box.x, y: box.y };
}

test.describe('Touch input in annotation mode', () => {
  test.use({ hasTouch: true });

  test('a touch drag draws an annotation', async ({ page }) => {
    const origin = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('tool-rectangle').click();

    await touchDrag(
      cdp,
      { x: origin.x + 100, y: origin.y + 100 },
      { x: origin.x + 220, y: origin.y + 190 },
    );
    await page.waitForTimeout(500);

    expect(await readAnnotations(page)).toHaveLength(1);
  });

  test('a second touch drag draws again, rather than wedging the tracker', async ({ page }) => {
    const origin = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('tool-rectangle').click();

    await touchDrag(
      cdp,
      { x: origin.x + 100, y: origin.y + 100 },
      { x: origin.x + 220, y: origin.y + 190 },
    );
    await page.waitForTimeout(400);
    await touchDrag(
      cdp,
      { x: origin.x + 300, y: origin.y + 100 },
      { x: origin.x + 420, y: origin.y + 190 },
    );
    await page.waitForTimeout(500);

    // The tracker does recover between gestures — the browser retires the
    // touch pointer after `touchend`, and the `pointerout` / `pointerleave`
    // that follow drive OSD's `stopTrackingPointer`, which clears both the
    // contact and the point. So each gesture fails on its own account. That
    // is what this pins: not a wedged tracker, but a defect that reproduces
    // every time rather than only on a cold first gesture.
    expect(await readAnnotations(page)).toHaveLength(2);
  });

  /**
   * Double-click detection (#168) runs inside `releaseHandler`, which touch
   * could not reach while the contact count never returned to zero — so the
   * gesture was documented as mouse-and-pen-only. Fixing the count makes it
   * reachable, which is a behaviour change worth pinning rather than leaving
   * to be discovered.
   */
  test('a touch double tap finishes a polyline', async ({ page }) => {
    const origin = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('tool-polyline').click();

    await touchTap(cdp, { x: origin.x + 120, y: origin.y + 120 });
    await page.waitForTimeout(120);
    await touchTap(cdp, { x: origin.x + 240, y: origin.y + 140 });
    await page.waitForTimeout(120);
    await touchDoubleTap(cdp, { x: origin.x + 300, y: origin.y + 240 });
    await page.waitForTimeout(600);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.geometry.type).toBe('polyline');
  });
});

test.describe('OSD gesture bookkeeping', () => {
  test.use({ hasTouch: true });

  test('mouse input in annotation mode does not trip the implausible-contacts clamp', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Implausible contacts')) warnings.push(message.text());
    });

    const origin = await openAnnotator(page);

    // Control: navigation mode forwards nothing, so any warning here would mean
    // OSD emits it regardless of us and this assertion proves nothing.
    await page.getByTestId('tool-navigate').click();
    await page.mouse.move(origin.x + 400, origin.y + 320);
    await page.mouse.down();
    await page.mouse.move(origin.x + 300, origin.y + 250, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(warnings).toEqual([]);

    // Treatment: the same gesture in annotation mode is forwarded.
    await page.getByTestId('tool-rectangle').click();
    await page.mouse.move(origin.x + 100, origin.y + 100);
    await page.mouse.down();
    await page.mouse.move(origin.x + 220, origin.y + 190, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // Mouse drawing works today only because `addContact()` silently clamps a
    // count of 2 back to 1 and warns. Asserting the warning is absent is what
    // distinguishes "we stopped double-counting" from "touch was special-cased".
    expect(warnings).toEqual([]);
  });

  test('touch input does not corrupt the tracked gesture points', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const origin = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('tool-rectangle').click();

    await touchDrag(
      cdp,
      { x: origin.x + 100, y: origin.y + 100 },
      { x: origin.x + 220, y: origin.y + 190 },
    );
    await page.waitForTimeout(400);

    // With the count doubled, `updatePointerMove` takes its `contacts === 2`
    // pinch branch and reads `currentPos` off a second gesture point that was
    // never tracked — one synchronous `TypeError` per move, thrown during the
    // gesture rather than after it. Drawing failing is the visible half of the
    // bug; this is the half that shows the contact list itself is wrong, so a
    // fix that restored drawing by some other route would still fail here.
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Forwarding regressions the touch fix could cause', () => {
  test.use({ hasTouch: true });

  /**
   * This one passes before the fix too, and that is the point of filing it
   * here rather than with the symptoms: `pressHandler` fires at
   * `contacts === 1`, which the *real* press reaches before the bubbled copy
   * takes it to 2. So presses were always delivered and only releases were
   * lost — selection, which Fabric commits on mousedown, worked the whole
   * time. The bug is narrower than "touch is inert": it is "touch gestures
   * that need a release are inert".
   */
  test('a touch tap still selects an existing annotation', async ({ page }) => {
    const origin = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);

    // Draw with the mouse, which works today, so this test isolates the
    // selection path rather than re-testing drawing. A circle specifically:
    // the button asserted below is gated on the selected annotation being one
    // (`Toolbar.tsx`), so a rectangle here would keep it hidden whether or not
    // the tap selected anything.
    await page.getByTestId('tool-circle').click();
    await page.mouse.move(origin.x + 190, origin.y + 180);
    await page.mouse.down();
    await page.mouse.move(origin.x + 260, origin.y + 180, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await readAnnotations(page)).toHaveLength(1);
    await expect(page.getByTestId('convert-to-rect')).toHaveCount(0);

    await page.getByTestId('tool-select').click();
    await touchTap(cdp, { x: origin.x + 190, y: origin.y + 180 });
    await page.waitForTimeout(400);

    // That button renders only while a circle is selected, so it stands in for
    // selection state without reaching into the store. Asserting it absent
    // above keeps this from passing on a button that was already showing.
    await expect(page.getByTestId('convert-to-rect')).toBeVisible();
  });
  test('dragging an existing annotation with the mouse commits its new position', async ({
    page,
  }) => {
    const origin = await openAnnotator(page);

    await page.getByTestId('tool-rectangle').click();
    await page.mouse.move(origin.x + 120, origin.y + 120);
    await page.mouse.down();
    await page.mouse.move(origin.x + 240, origin.y + 220, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    const before = (await readAnnotations(page))[0];
    expect(before?.geometry.origin).toBeDefined();

    // Drag the whole shape. Fabric relocates its `pointerup` / `pointermove`
    // listeners to the document once a drag starts, so a fix that stops the
    // synthetic release bubbling leaves Fabric with a press and no mouse-up.
    // Drawing breaks on that too (it commits on the release); what this adds
    // is the mouse path, which no symptom test drives.
    await page.getByTestId('tool-select').click();
    await page.mouse.move(origin.x + 180, origin.y + 170);
    await page.mouse.down();
    await page.mouse.move(origin.x + 280, origin.y + 270, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const after = (await readAnnotations(page))[0];
    expect(after?.geometry.origin).toBeDefined();
    expect(after!.geometry.origin!.x).toBeGreaterThan(before!.geometry.origin!.x + 20);
    expect(after!.geometry.origin!.y).toBeGreaterThan(before!.geometry.origin!.y + 20);
  });

  test('touch still pans the viewer in navigation mode', async ({ page }) => {
    const origin = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('tool-navigate').click();

    const centre = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.querySelector('.openseadragon-canvas') as unknown as {
          __osdViewer?: { viewport: { getCenter(): { x: number; y: number } } };
        } | null;
        const c = el?.__osdViewer?.viewport.getCenter();
        return c ? `${c.x.toFixed(4)},${c.y.toFixed(4)}` : 'none';
      });

    const before = await centre();
    expect(before).not.toBe('none');

    await touchDrag(
      cdp,
      { x: origin.x + 400, y: origin.y + 300 },
      { x: origin.x + 280, y: origin.y + 210 },
    );
    await page.waitForTimeout(800);

    // Touch-pan is the one touch interaction that works today, which makes it
    // the likeliest collateral damage: navigation mode returns before any
    // forwarding happens, so a fix reaching into the tracker or the contact
    // list rather than into the forwarding itself could break it.
    expect(await centre()).not.toBe(before);
  });
});
