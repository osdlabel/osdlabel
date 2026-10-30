/**
 * A touch gesture that the platform cancels is undone, not committed.
 *
 * When the OS or the browser takes a touch or pen contact away mid-gesture (an
 * edge swipe, palm rejection, a system dialog, an orientation change), Chrome
 * fires `pointercancel` for it and no `pointerup`. OSD's MouseTracker answers
 * a cancel with `stopTrackingPointer` and never calls `releaseHandler`, so
 * `FabricOverlay` used to forward nothing at all. Fabric's transform stayed
 * open: the canvas showed the shape where the finger had left it while the
 * stored geometry kept the old one, the next pointer movement anywhere (a
 * hover, a drag on empty canvas) carried the shape on, and the next release
 * committed it there. A drawing tool's preview stayed painted, and a tap on
 * the toolbar committed it as an annotation the user never finished.
 *
 * Cancel means revert, the platform's meaning for `pointercancel`: the shape
 * goes back to where it was at the press, nothing is committed, a drawing
 * tool drops its preview (and a polyline the vertex that press placed), and
 * the gesture is over, so later input starts afresh.
 *
 * CDP's `touchCancel` produces a genuine `pointercancel` (trusted,
 * `isPrimary`, `button` -1), the path a real interruption takes, which a
 * synthetic DOM event would not exercise. Chromium only, as the suite is.
 *
 * Paint is judged from the lower canvas's pixels with the rectangle suite's
 * judge, state from the `annotations-json` readout, and the open transform
 * (`_currentTransform`, Fabric's own record of a gesture in progress) is read
 * as the mechanism: while it is set, the next move transforms the shape.
 */
import type { CDPSession, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  annotationsText,
  bodyPoint,
  controlOnPage,
  deselect,
  drawRectangle,
  expectPaintedAs,
  expectPointClose,
  imageToPage,
  openAnnotator,
  pageToImage,
  paintedBounds,
  readAnnotations,
  referenceCentre,
  scaleOf,
  selectAt,
  settle,
  type Point,
  type StoredRectangle,
  type View,
} from './rectangle/helpers.js';

// ── Touch, through CDP ───────────────────────────────────────────────────

/** Put one finger down at `path[0]` and drag it through the rest of `path`, without lifting it. */
async function touchPressAndMove(cdp: CDPSession, path: readonly Point[]): Promise<void> {
  const [start, ...rest] = path;
  if (!start) throw new Error('a touch path needs a start');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: start.x, y: start.y, id: 1 }],
  });
  for (const p of rest) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: p.x, y: p.y, id: 1 }],
    });
  }
}

/** The platform takes the finger away: `pointercancel`, and no `pointerup`. */
async function touchCancel(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
}

/** The finger lifts normally. */
async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function touchTap(cdp: CDPSession, at: Point): Promise<void> {
  await touchPressAndMove(cdp, [at]);
  await touchEnd(cdp);
}

/** `steps` points from `from`, each `step` further on, `from` included. */
function straightPath(from: Point, step: Point, steps: number): Point[] {
  return Array.from({ length: steps + 1 }, (_, k) => ({
    x: from.x + step.x * k,
    y: from.y + step.y * k,
  }));
}

/** `steps + 1` points carrying `from` `degrees` clockwise around `centre`. */
function arcPath(centre: Point, from: Point, degrees: number, steps: number): Point[] {
  const dx = from.x - centre.x;
  const dy = from.y - centre.y;
  return Array.from({ length: steps + 1 }, (_, k) => {
    const t = (((degrees * k) / steps) * Math.PI) / 180;
    return {
      x: centre.x + dx * Math.cos(t) - dy * Math.sin(t),
      y: centre.y + dx * Math.sin(t) + dy * Math.cos(t),
    };
  });
}

// ── What Fabric holds ────────────────────────────────────────────────────

/** A Fabric object's placement, as the overlay's canvas holds it right now. */
interface LiveObject {
  readonly id: string | null;
  readonly left: number;
  readonly top: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly angle: number;
  readonly points: readonly Point[] | null;
}

interface LiveCanvas {
  /** Every object on the canvas, annotations and previews alike. */
  readonly objects: readonly LiveObject[];
  /** Whether Fabric still has a gesture in progress (`_currentTransform` is set). */
  readonly transformOpen: boolean;
}

interface CanvasHandleShape {
  readonly canvas: {
    readonly _currentTransform: unknown;
    getObjects(): readonly {
      readonly id?: string;
      readonly left: number;
      readonly top: number;
      readonly scaleX: number;
      readonly scaleY: number;
      readonly angle: number;
      readonly points?: readonly Point[];
    }[];
    getActiveObject(): { readonly oCoords?: Record<string, Point> } | null | undefined;
  };
}

async function liveCanvas(page: Page): Promise<LiveCanvas> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: CanvasHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    return {
      objects: overlay.canvas.getObjects().map((o) => ({
        id: o.id ?? null,
        left: o.left,
        top: o.top,
        scaleX: o.scaleX,
        scaleY: o.scaleY,
        angle: o.angle,
        points: o.points ? o.points.map((p) => ({ x: p.x, y: p.y })) : null,
      })),
      transformOpen: overlay.canvas._currentTransform !== null,
    };
  });
}

/** The one annotation object on the canvas. */
async function onlyLiveObject(page: Page): Promise<LiveObject> {
  const { objects } = await liveCanvas(page);
  expect(objects, 'expected exactly one object on the canvas').toHaveLength(1);
  return objects[0]!;
}

function expectSamePlacement(actual: LiveObject, expected: LiveObject, what: string): void {
  for (const key of ['left', 'top', 'scaleX', 'scaleY', 'angle'] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${what}: ${key} is ${actual[key]}, was ${expected[key]} at the press`,
    ).toBeLessThan(1e-6);
  }
}

/** Where the selected object's control `key` is drawn, in page px. */
async function activeControlOnPage(page: Page, view: View, key: string): Promise<Point> {
  const at = await page.evaluate((k) => {
    const host = document.querySelector('.openseadragon-canvas') as
      | (Element & { __osdOverlay?: CanvasHandleShape })
      | null;
    const overlay = host?.__osdOverlay;
    if (!overlay) throw new Error('overlay test hook not installed');
    const point = overlay.canvas.getActiveObject()?.oCoords?.[k];
    if (!point) throw new Error(`no active object, or it has no ${k} control`);
    return { x: point.x, y: point.y };
  }, key);
  return { x: view.canvasOrigin.x + at.x, y: view.canvasOrigin.y + at.y };
}

// ── The measurement label ────────────────────────────────────────────────

interface Label {
  readonly centre: Point;
  readonly text: string;
}

async function measurementLabel(page: Page, id: string): Promise<Label> {
  const label = page.locator(
    `[data-osdlabel="decoration-text"][data-decoration-id="measurement:${id}"]`,
  );
  await expect(label).toHaveCount(1);
  const box = await label.boundingBox();
  expect(box, 'the measurement label is not laid out').not.toBeNull();
  return {
    centre: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    text: (await label.textContent()) ?? '',
  };
}

/** Two rAFs: the live decoration update is throttled to one per frame. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

// ── Setup ────────────────────────────────────────────────────────────────

const A: Point = { x: 300.4, y: 250.2 };
const B: Point = { x: 520.7, y: 400.9 };

/** Draw a rectangle with the mouse and select it with the select tool. */
async function drawAndSelect(page: Page, view: View): Promise<StoredRectangle> {
  const drawn = await drawRectangle(page, view, A, B);
  await selectAt(page, bodyPoint(view, drawn.geometry), drawn.id);
  return drawn;
}

/**
 * A page point on the canvas, well clear of the rectangle drawn from `A` to
 * `B`: near the canvas's bottom-left corner.
 */
function emptyCanvasPoint(view: View): Point {
  const p = { x: view.canvasOrigin.x + 60, y: view.canvasOrigin.y + view.canvasSize.height - 60 };
  const image = pageToImage(view, p);
  expect(
    image.x < A.x - 20 || image.y > B.y + 20,
    `(${p.x}, ${p.y}) is not clear of the rectangle`,
  ).toBe(true);
  return p;
}

/** The gestures a selected rectangle takes, each as the touch path it is driven along. */
const EDITS: readonly {
  readonly name: string;
  readonly path: (page: Page, view: View, drawn: StoredRectangle) => Promise<Point[]>;
  /** What must differ, mid-gesture, for the gesture to have reached Fabric at all. */
  readonly moved: (live: LiveObject, atPress: LiveObject) => boolean;
  /**
   * Whether the measurement label changes mid-gesture. A rotation turns the
   * rectangle about the centre the label sits on, and leaves its area and
   * perimeter alone.
   */
  readonly labelFollows: boolean;
}[] = [
  {
    name: 'move',
    path: async (_page, view, drawn) =>
      straightPath(bodyPoint(view, drawn.geometry), { x: 11, y: 6 }, 6),
    moved: (live, atPress) => Math.hypot(live.left - atPress.left, live.top - atPress.top) > 30,
    labelFollows: true,
  },
  {
    name: 'resize',
    path: async (page) => straightPath(await controlOnPage(page, 'br'), { x: 10, y: 8 }, 6),
    moved: (live, atPress) => live.scaleX > atPress.scaleX * 1.1,
    labelFollows: true,
  },
  {
    name: 'rotation',
    path: async (page, view, drawn) =>
      arcPath(
        imageToPage(view, referenceCentre(drawn.geometry)),
        await controlOnPage(page, 'mtr'),
        35,
        7,
      ),
    moved: (live, atPress) => Math.abs(live.angle - atPress.angle) > 15,
    labelFollows: false,
  },
];

test.describe('A touch gesture the platform cancels is undone', () => {
  test.use({ hasTouch: true });

  for (const edit of EDITS) {
    test(`a cancelled ${edit.name} puts the rectangle back, its label too, and stores nothing`, async ({
      page,
    }) => {
      const view = await openAnnotator(page);
      const drawn = await drawAndSelect(page, view);
      const before = await annotationsText(page);
      const atPress = await onlyLiveObject(page);
      const labelAtPress = await measurementLabel(page, drawn.id);
      const cdp = await page.context().newCDPSession(page);

      await touchPressAndMove(cdp, await edit.path(page, view, drawn));
      await nextFrames(page);

      // The gesture reached Fabric: without this, a test whose touches never
      // landed would pass on an untouched rectangle.
      const midGesture = await onlyLiveObject(page);
      expect(
        edit.moved(midGesture, atPress),
        `the ${edit.name} never reached the shape: ${JSON.stringify(midGesture)}`,
      ).toBe(true);
      if (edit.labelFollows) {
        // The label follows the live shape while the finger is down, so it
        // has somewhere to come back from.
        const labelMid = await measurementLabel(page, drawn.id);
        expect(
          labelMid.text !== labelAtPress.text ||
            Math.hypot(
              labelMid.centre.x - labelAtPress.centre.x,
              labelMid.centre.y - labelAtPress.centre.y,
            ) > 5,
          'the label did not follow the shape mid-gesture',
        ).toBe(true);
      }

      await touchCancel(cdp);
      await settle(page);

      expect(await annotationsText(page), 'the cancelled gesture committed something').toBe(before);
      const after = await liveCanvas(page);
      expect(after.transformOpen, "Fabric's transform is still open").toBe(false);
      expect(after.objects).toHaveLength(1);
      expectSamePlacement(after.objects[0]!, atPress, `after the cancelled ${edit.name}`);

      // The label is derived from the stored geometry again: same place, same
      // measurements as before the press.
      await nextFrames(page);
      const labelAfter = await measurementLabel(page, drawn.id);
      expect(labelAfter.text).toBe(labelAtPress.text);
      expectPointClose(labelAfter.centre, labelAtPress.centre, 0.5, 'the label after the cancel');

      // And what is painted is what is stored.
      await deselect(page);
      expect(await annotationsText(page)).toBe(before);
      await expectPaintedAs(page, drawn.geometry, `after the cancelled ${edit.name}`);
    });
  }

  test('after a cancelled drag, later input elsewhere does not carry the rectangle off', async ({
    page,
  }) => {
    const view = await openAnnotator(page);
    const drawn = await drawAndSelect(page, view);
    const before = await annotationsText(page);
    const atPress = await onlyLiveObject(page);
    const cdp = await page.context().newCDPSession(page);

    await touchPressAndMove(cdp, straightPath(bodyPoint(view, drawn.geometry), { x: 11, y: 6 }, 6));
    await touchCancel(cdp);
    await settle(page);

    // A mouse hovering with no button down. Before the fix Fabric's
    // document-level `pointermove` listener, still attached from the press,
    // dragged the shape after the cursor.
    const empty = emptyCanvasPoint(view);
    await page.mouse.move(empty.x + 200, empty.y - 150, { steps: 4 });
    await page.mouse.move(empty.x, empty.y, { steps: 4 });
    // An unrelated one-finger drag on empty canvas, released normally. Before
    // the fix it moved the shape to this finger and committed it there.
    await touchPressAndMove(cdp, straightPath(empty, { x: 8, y: -5 }, 4));
    await touchEnd(cdp);
    await settle(page);

    expect(await annotationsText(page), 'later input moved the rectangle').toBe(before);
    expectSamePlacement(await onlyLiveObject(page), atPress, 'after the later input');
    await deselect(page);
    await expectPaintedAs(page, drawn.geometry, 'after the later input');
  });

  for (const tool of ['rectangle', 'freeHandPath'] as const) {
    test(`a cancelled ${tool} stroke leaves no preview behind and stores nothing`, async ({
      page,
    }) => {
      const view = await openAnnotator(page);
      const cdp = await page.context().newCDPSession(page);
      await page.getByTestId(`tool-${tool}`).click();
      const start = imageToPage(view, A);

      await touchPressAndMove(cdp, straightPath(start, { x: 14, y: 9 }, 8));
      await nextFrames(page);
      // The stroke reached the tool: its preview is painted.
      expect((await liveCanvas(page)).objects, 'no preview while drawing').toHaveLength(1);
      expect(await paintedBounds(page), 'the preview is not painted').not.toBeNull();

      await touchCancel(cdp);
      await settle(page);

      expect(await readAnnotations(page)).toHaveLength(0);
      const after = await liveCanvas(page);
      expect(after.objects, 'the preview is still on the canvas').toHaveLength(0);
      expect(after.transformOpen).toBe(false);
      expect(await paintedBounds(page), 'the preview is still painted').toBeNull();

      // Before the fix a click on the toolbar released Fabric's open gesture,
      // which committed the orphaned preview, stretched to the button.
      await page.getByTestId('tool-select').click();
      await settle(page);
      expect(await readAnnotations(page)).toHaveLength(0);

      // The tool still draws, and draws only the stroke it is given.
      await page.getByTestId(`tool-${tool}`).click();
      const before = await annotationsText(page);
      await touchPressAndMove(cdp, straightPath(imageToPage(view, B), { x: -14, y: -9 }, 8));
      await touchEnd(cdp);
      await settle(page, before);
      expect(await readAnnotations(page)).toHaveLength(1);
      expect((await liveCanvas(page)).objects).toHaveLength(1);
    });
  }

  test('a cancelled polyline press takes back the vertex it placed, and only that one', async ({
    page,
  }) => {
    const view = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('tool-polyline').click();
    const placed = [
      { x: view.canvasOrigin.x + 200, y: view.canvasOrigin.y + 160 },
      { x: view.canvasOrigin.x + 330, y: view.canvasOrigin.y + 190 },
    ];
    const cancelled = { x: view.canvasOrigin.x + 420, y: view.canvasOrigin.y + 300 };
    const last = { x: view.canvasOrigin.x + 300, y: view.canvasOrigin.y + 330 };

    // Taps far enough apart that no two pair as a double tap.
    for (const p of placed) {
      await touchTap(cdp, p);
      await page.waitForTimeout(150);
    }
    // A press places a vertex, so the cancelled press had placed one.
    await touchPressAndMove(cdp, [cancelled]);
    await touchCancel(cdp);
    await page.waitForTimeout(150);
    await touchTap(cdp, last);
    await page.waitForTimeout(150);
    // Finish the open path. The press focused the viewer, so the key reaches it.
    const before = await annotationsText(page);
    await page.keyboard.press('Enter');
    await settle(page, before);

    const all = await readAnnotations(page);
    expect(all).toHaveLength(1);
    const geometry = all[0]!.geometry as { type: string; points?: readonly Point[] };
    expect(geometry.type).toBe('polyline');
    const expected = [...placed, last].map((p) => pageToImage(view, p));
    expect(
      geometry.points?.length,
      `stored ${JSON.stringify(geometry.points)}, expected the taps ${JSON.stringify(expected)}`,
    ).toBe(expected.length);
    const tol = 1.5 / scaleOf(view);
    expected.forEach((p, i) => expectPointClose(geometry.points![i]!, p, tol, `vertex ${i}`));
  });

  test('a cancelled vertex drag, and a cancelled vertex insert, leave the polygon as stored', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const view = await openAnnotator(page);
    const cdp = await page.context().newCDPSession(page);
    const at = (x: number, y: number): Point => ({
      x: view.canvasOrigin.x + x,
      y: view.canvasOrigin.y + y,
    });

    // A square polygon, closed on its first vertex, drawn with the mouse.
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
    const stored = await readAnnotations(page);
    expect(stored).toHaveLength(1);
    const storedPoints = (stored[0]!.geometry as { points?: readonly Point[] }).points;
    expect(storedPoints).toHaveLength(4);

    // A long press on the body enters vertex-edit mode. Not at the centroid,
    // where the measurement label sits and would take the touch.
    await page.getByTestId('tool-select').click();
    await touchPressAndMove(cdp, [at(225, 295)]);
    await page.waitForTimeout(800);
    await touchEnd(cdp);
    await settle(page);
    const before = await annotationsText(page);
    const atPress = await onlyLiveObject(page);
    expect(atPress.points).toHaveLength(4);

    /** The live polygon matches the stored one, vertex for vertex. */
    const expectLiveIsStored = async (what: string): Promise<void> => {
      const live = await liveCanvas(page);
      expect(live.transformOpen, `${what}: Fabric's transform is still open`).toBe(false);
      expect(live.objects).toHaveLength(1);
      expectSamePlacement(live.objects[0]!, atPress, what);
      const points = live.objects[0]!.points;
      expect(points, `${what}: ${JSON.stringify(points)}`).toHaveLength(4);
      points!.forEach((p, i) => expectPointClose(p, atPress.points![i]!, 1e-6, `${what}: p${i}`));
    };

    for (const [control, what] of [
      ['p1', 'a cancelled vertex drag'],
      ['ins0', 'a cancelled vertex insert'],
    ] as const) {
      const from = await activeControlOnPage(page, view, control);
      await touchPressAndMove(cdp, straightPath(from, { x: 6, y: -9 }, 5));
      await nextFrames(page);
      const mid = await onlyLiveObject(page);
      expect(
        JSON.stringify(mid.points) !== JSON.stringify(atPress.points),
        `${what} never reached the polygon`,
      ).toBe(true);

      await touchCancel(cdp);
      await settle(page);

      expect(await annotationsText(page), `${what} committed something`).toBe(before);
      await expectLiveIsStored(`after ${what}`);
    }

    // Edit mode survives, with handles for the vertices the polygon has: a
    // real drag of the third vertex commits that vertex, and only it, moved.
    const from = await activeControlOnPage(page, view, 'p2');
    await touchPressAndMove(cdp, straightPath(from, { x: 7, y: 7 }, 4));
    await touchEnd(cdp);
    await settle(page, before);
    const edited = (await readAnnotations(page))[0]!.geometry as { points?: readonly Point[] };
    expect(edited.points).toHaveLength(4);
    // The edit rebuilds the polygon from its saved data, which `toObject()`
    // rounds to 4 decimals.
    const tol = 0.01;
    for (const i of [0, 1, 3]) {
      expectPointClose(edited.points![i]!, storedPoints![i]!, tol, `untouched vertex ${i}`);
    }
    expect(
      Math.hypot(
        edited.points![2]!.x - storedPoints![2]!.x,
        edited.points![2]!.y - storedPoints![2]!.y,
      ),
    ).toBeGreaterThan(10);
    expect(pageErrors).toEqual([]);
  });
});
