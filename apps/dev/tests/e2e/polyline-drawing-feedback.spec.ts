import { test, expect, type Page } from '@playwright/test';

/**
 * Drawing feedback for the polyline tool (issue #156): the in-progress preview
 * is drawn in the tool constraint's `defaultStyle`, and every clicked vertex is
 * marked, with the first one distinct because it is the close target.
 *
 * Assertions read real rendered pixels off the Fabric canvas and real committed
 * state, rather than full-image snapshots — snapshots of a tiled OSD viewer are
 * not stable across engines, and this suite has to hold in CI's Chromium too.
 *
 * The offsets below are measured, not guessed. With the harness's 3px stroke,
 * on the vertical axis through a vertex (where no segment runs, provided the
 * neighbouring vertices are placed horizontally):
 *
 *   first vertex, hollow:  dy 0..-2 segment · dy -3 EMPTY (the hole) · dy -5,-6 ring
 *   first vertex, filled:  dy 0..-6 solid
 *   ordinary vertex:       dy 0..-3 dot · dy -4 and beyond empty
 *
 * So dy -5 separates the first vertex's ring from an ordinary vertex's dot, and
 * dy -3 separates a hollow ring from a filled one.
 */

interface StoredAnnotation {
  geometry: { type: string; points?: { x: number; y: number }[] };
  rawAnnotationData: { data: { stroke?: string } };
}
type ByImage = Record<string, Record<string, StoredAnnotation>>;

/** The 'General' context sets this on its polyline tool in the dev harness. */
const PREVIEW_COLOR = { r: 0, g: 229, b: 255 };
/** Per-channel slack. The chrome is drawn onto a transparent canvas — the OSD
 *  image is a different element — so the colour lands exact and this only has
 *  to absorb rounding, not compositing against photographic pixels. */
const CHANNEL_TOLERANCE = 24;
/** Ignore antialias fringes, so "a faint smear of roughly-cyan" is not a hit. */
const MIN_ALPHA = 128;

async function readAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as ByImage;
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/**
 * Whether any pixel within `radius` CSS px of (x, y) is solidly the preview
 * colour. `radius: 0` reads the single pixel, for assertions that turn on a
 * gap only a couple of pixels wide.
 *
 * Throws when the sample falls outside the canvas: a silent `false` there would
 * let every negative assertion in this file pass for a coordinate bug rather
 * than for the absence it is asserting.
 */
async function hasPreviewColorNear(page: Page, x: number, y: number, radius = 2): Promise<boolean> {
  return page.evaluate(
    ({ x, y, radius, color, tolerance, minAlpha }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.lower-canvas');
      if (!canvas) throw new Error('lower canvas not found');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2d context not available');

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const cx = Math.round((x - rect.left) * scaleX);
      const cy = Math.round((y - rect.top) * scaleY);
      const span = Math.round(radius * scaleX);

      const left = cx - span;
      const top = cy - span;
      const size = span * 2 + 1;
      if (left < 0 || top < 0 || left + size > canvas.width || top + size > canvas.height) {
        throw new Error(`sample (${x}, ${y}) -> canvas (${cx}, ${cy}) is outside the canvas`);
      }

      const { data } = ctx.getImageData(left, top, size, size);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! < minAlpha) continue;
        if (
          Math.abs(data[i]! - color.r) <= tolerance &&
          Math.abs(data[i + 1]! - color.g) <= tolerance &&
          Math.abs(data[i + 2]! - color.b) <= tolerance
        ) {
          return true;
        }
      }
      return false;
    },
    { x, y, radius, color: PREVIEW_COLOR, tolerance: CHANNEL_TOLERANCE, minAlpha: MIN_ALPHA },
  );
}

test.describe('Polyline drawing feedback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });
    // Bundled local image, so the viewer opens without network access.
    await page.getByTestId('filmstrip-item-jpg').click();
    await page.getByRole('combobox').selectOption({ label: 'General' });
    await page.locator('canvas.upper-canvas').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.getByTestId('tool-polyline').click();
  });

  /**
   * Three vertices in an L, the first two strictly horizontal so the vertical
   * axis above each of them carries only its marker, and a cursor parked well
   * away from all of them.
   */
  async function drawL(page: Page) {
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    const first = {
      x: Math.round(box.x + box.width * 0.35),
      y: Math.round(box.y + box.height * 0.4),
    };
    const second = { x: first.x + 200, y: first.y };
    const third = { x: first.x + 200, y: first.y + 160 };

    for (const v of [first, second, third]) {
      await page.mouse.move(v.x, v.y);
      await page.mouse.click(v.x, v.y);
      await page.waitForTimeout(120);
    }
    await page.mouse.move(first.x - 120, first.y + 260);
    await page.waitForTimeout(300);

    return { first, second, third };
  }

  test('draws the in-progress path in the configured style', async ({ page }) => {
    const { first } = await drawL(page);

    // Mid-segment, 60px clear of either vertex marker: this is the preview
    // polyline itself, which is what `defaultStyle` has to reach. The window
    // spans a whole dash period so the dash phase cannot decide the result.
    expect(await hasPreviewColorNear(page, first.x + 60, first.y, 6)).toBe(true);
    // Off the segment entirely — the line is 3px wide, not a wash of colour.
    expect(await hasPreviewColorNear(page, first.x + 60, first.y - 40, 6)).toBe(false);
  });

  test('marks the first vertex larger than the rest, as the close target', async ({ page }) => {
    const { first, second } = await drawL(page);

    // Single pixels, not neighbourhoods: shrinking the first vertex to the
    // ordinary radius still leaves its 2px ring stroke reaching dy -4, so a
    // window wide enough to include dy -4 cannot tell the two radii apart.

    // The first vertex's ring reaches dy -5…
    expect(await hasPreviewColorNear(page, first.x, first.y - 5, 0)).toBe(true);
    // …where an ordinary vertex's smaller dot has already ended…
    expect(await hasPreviewColorNear(page, second.x, second.y - 5, 0)).toBe(false);
    // …though it is certainly drawn, so the line above is about size and not
    // about the second marker having gone missing.
    expect(await hasPreviewColorNear(page, second.x, second.y - 2, 0)).toBe(true);
  });

  test('fills the first vertex once clicking there would close the path', async ({ page }) => {
    const { first } = await drawL(page);

    // Dead centre of the ring's hole, read as a single pixel.
    expect(await hasPreviewColorNear(page, first.x, first.y - 3, 0)).toBe(false);

    await page.mouse.move(first.x + 3, first.y + 3);
    await page.waitForTimeout(300);

    // Within CLOSE_THRESHOLD_SCREEN_PX the ring fills in.
    expect(await hasPreviewColorNear(page, first.x, first.y - 3, 0)).toBe(true);
  });

  test('commits nothing until the path is finished', async ({ page }) => {
    const { first } = await drawL(page);

    // Positive control: a path really is in progress, so the assertion below
    // cannot pass merely because the tool did nothing at all.
    expect(await hasPreviewColorNear(page, first.x + 60, first.y, 6)).toBe(true);
    // The preview and its markers are chrome, never annotations.
    expect(await readAnnotations(page)).toHaveLength(0);
  });

  test('clicking the first vertex closes the path into a styled polygon', async ({ page }) => {
    const { first } = await drawL(page);

    // Within CLOSE_THRESHOLD_SCREEN_PX (10) of the first vertex.
    await page.mouse.move(first.x + 3, first.y + 3);
    await page.mouse.click(first.x + 3, first.y + 3);
    await page.waitForTimeout(300);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    const committed = annotations[0]!;
    expect(committed.geometry.type).toBe('polygon');
    expect(committed.geometry.points).toHaveLength(3);
    // The style that drove the preview is the style that gets committed.
    expect(committed.rawAnnotationData.data.stroke).toBe('#00e5ff');
  });

  /**
   * Double click to finish (issue #168).
   *
   * This gesture cannot be unit-tested honestly. It does not arrive through
   * `onPointerDown` at all — input is routed by an OSD MouseTracker, so every
   * forwarded `pointerdown` carries `detail: 0` — and the overlay pairs the two
   * releases itself. A unit test can only assert against a hand-built event,
   * which is exactly what let the broken `event.detail === 2` branch look
   * covered for as long as it did. So the gesture is asserted here, against
   * real browser input.
   */
  test('double click ends the path open, at the double-clicked point', async ({ page }) => {
    const { first, third } = await drawL(page);

    // Somewhere new, and well clear of the first vertex so the close target
    // cannot be what finishes the path.
    const finishAt = { x: third.x - 150, y: third.y + 40 };
    await page.mouse.dblclick(finishAt.x, finishAt.y);
    await page.waitForTimeout(300);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    const committed = annotations[0]!;
    // Open, not closed: that is the whole point of the gesture.
    expect(committed.geometry.type).toBe('polyline');
    // The L's three vertices plus the double-clicked one — four, not five. The
    // gesture delivers two pointerdowns, and the duplicate is dropped.
    expect(committed.geometry.points).toHaveLength(4);
    expect(committed.rawAnnotationData.data.stroke).toBe('#00e5ff');
    // The drawing chrome is gone once the shape is committed.
    expect(await hasPreviewColorNear(page, first.x, first.y - 5, 1)).toBe(false);
  });

  test('two slow clicks in one place do not finish the path', async ({ page }) => {
    await drawL(page);
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    const spot = {
      x: Math.round(box.x + box.width * 0.2),
      y: Math.round(box.y + box.height * 0.7),
    };

    // Same position, but beyond OSD's dblClickTimeThreshold (300ms). The
    // overlay pairs releases by time and distance, and a regression that
    // ignored the clock would read every click as a double click and finish
    // the path on the first one.
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(700);
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(300);

    expect(await readAnnotations(page)).toHaveLength(0);

    // Positive control: the path really is still live, so the assertion above
    // is about the clicks not finishing it rather than about there being
    // nothing to finish.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await readAnnotations(page)).toHaveLength(1);
  });

  test('the finish shortcut ends the path open, leaving a polyline', async ({ page }) => {
    const { first } = await drawL(page);

    // Enter (DEFAULT_KEYBOARD_SHORTCUTS.polylineFinish) ends the path open.
    // Double click does too, since #168 — covered separately below.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.geometry.type).toBe('polyline');
    expect(annotations[0]!.rawAnnotationData.data.stroke).toBe('#00e5ff');
    // The chrome is gone once the shape is committed.
    expect(await hasPreviewColorNear(page, first.x, first.y - 5, 1)).toBe(false);
  });

  test('cancelling clears the preview and markers off the canvas', async ({ page }) => {
    const { first } = await drawL(page);
    expect(await hasPreviewColorNear(page, first.x, first.y - 5, 1)).toBe(true);
    expect(await hasPreviewColorNear(page, first.x + 60, first.y, 6)).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Both the markers and the preview line are gone, and nothing was committed
    // in their place.
    expect(await hasPreviewColorNear(page, first.x, first.y - 5, 1)).toBe(false);
    expect(await hasPreviewColorNear(page, first.x + 60, first.y, 6)).toBe(false);
    expect(await readAnnotations(page)).toHaveLength(0);
  });
});
