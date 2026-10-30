/**
 * A mask never joins a multi-selection's transform.
 *
 * A mask's Fabric image is locked against moving, scaling and rotating:
 * painting is the only way to change one. But Fabric checks only the transform
 * target's locks, and the target of a group drag is the `ActiveSelection`, so
 * a drag-box that touched a mask's box carried the mask's image along with the
 * shapes while its stored geometry and pixels stayed put. The cell reuses a
 * mask's object while its pixels are unchanged, so the displaced image also
 * outlived the commit and every rebuild after it.
 *
 * The specs pin, through the real input routing and on both bindings, that a
 * drag-box over two rectangles and a mask selects the rectangles only, and
 * that dragging that selection moves and saves the rectangles and leaves the
 * mask where its pixels are, on the canvas and in state, also after a
 * rebuild.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  annotationsText,
  drag,
  imageToPage,
  onPixel,
  openAnnotator,
  readAnnotations,
  scaleOf,
  settle,
  waitForStableView,
  type Point,
  type RectangleGeometry,
  type View,
} from './rectangle/helpers.js';

interface Placement {
  readonly left: number;
  readonly top: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly angle: number;
}

interface FabricShape {
  readonly id?: string;
  readonly left: number;
  readonly top: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly angle: number;
  getObjects?(): FabricShape[];
}
type OverlayHost = Element & {
  __osdOverlay?: {
    canvas: { getActiveObject(): FabricShape | undefined; getObjects(): FabricShape[] };
  };
};

/** Where the Fabric object of annotation `id` is placed on the canvas. */
async function placementOf(page: Page, id: string): Promise<Placement> {
  return page.evaluate((target) => {
    const host = document.querySelector('.openseadragon-canvas') as OverlayHost | null;
    const canvas = host?.__osdOverlay?.canvas;
    if (!canvas) throw new Error('overlay test hook not installed');
    const object = canvas.getObjects().find((o) => o.id === target);
    if (!object) throw new Error(`no object for ${target}`);
    const { left, top, scaleX, scaleY, angle } = object;
    return { left, top, scaleX, scaleY, angle };
  }, id);
}

/** The ids of the selected objects, and whether they form a group. */
async function readSelection(page: Page): Promise<{ group: boolean; ids: string[] }> {
  return page.evaluate(() => {
    const host = document.querySelector('.openseadragon-canvas') as OverlayHost | null;
    const canvas = host?.__osdOverlay?.canvas;
    if (!canvas) throw new Error('overlay test hook not installed');
    const active = canvas.getActiveObject();
    if (!active) return { group: false, ids: [] };
    const group = active.id === undefined && typeof active.getObjects === 'function';
    const members = group ? active.getObjects!() : [active];
    return { group, ids: members.map((m) => m.id ?? '').sort() };
  });
}

const at = (view: View, p: Point): Point => onPixel(imageToPage(view, p));

/** Run `gesture`, wait for its commit, and return the ids it added. */
async function added(page: Page, gesture: () => Promise<void>): Promise<string[]> {
  const before = new Set((await readAnnotations(page)).map((a) => a.id));
  const text = await annotationsText(page);
  await gesture();
  await settle(page, text);
  return (await readAnnotations(page)).filter((a) => !before.has(a.id)).map((a) => a.id);
}

/** Image px on the landscape image (1280×800): two rectangles with a painted band between them. */
const LAYOUT = {
  left: { a: { x: 300, y: 250 }, b: { x: 400, y: 330 } },
  right: { a: { x: 620, y: 250 }, b: { x: 720, y: 330 } },
  band: { from: { x: 450, y: 290 }, to: { x: 570, y: 290 } },
  box: { a: { x: 255, y: 205 }, b: { x: 765, y: 375 } },
} as const;

async function setUp(page: Page) {
  const view = await openAnnotator(page);
  await page.getByTestId('tool-rectangle').click();
  const [left] = await added(page, () =>
    drag(page, at(view, LAYOUT.left.a), at(view, LAYOUT.left.b), 6),
  );
  const [right] = await added(page, () =>
    drag(page, at(view, LAYOUT.right.a), at(view, LAYOUT.right.b), 6),
  );
  await page.getByTestId('tool-segmentationBrush').click();
  const [mask] = await added(page, () =>
    drag(page, at(view, LAYOUT.band.from), at(view, LAYOUT.band.to), 10),
  );
  expect(
    [left, right, mask].every((id) => id !== undefined),
    'three annotations',
  ).toBe(true);
  const stored = await readAnnotations(page);
  expect(stored.find((a) => a.id === mask)?.geometry.type).toBe('mask');
  return { view, left: left!, right: right!, mask: mask! };
}

test.describe('Multi-selection and masks', () => {
  test('a drag-box over shapes and a mask selects the shapes only', async ({ page }) => {
    const { view, left, right } = await setUp(page);

    await page.getByTestId('tool-select').click();
    await drag(page, at(view, LAYOUT.box.a), at(view, LAYOUT.box.b), 10);

    await expect
      .poll(() => readSelection(page))
      .toEqual({ group: true, ids: [left, right].sort() });
  });

  test('dragging that selection saves the shapes and leaves the mask where its pixels are', async ({
    page,
  }) => {
    const { view, left, right, mask } = await setUp(page);
    const maskPlacement = await placementOf(page, mask);
    const before = await readAnnotations(page);
    const storedMask = JSON.stringify(before.find((a) => a.id === mask));
    const originOf = (all: typeof before, id: string): Point =>
      (all.find((a) => a.id === id)!.geometry as RectangleGeometry).origin;

    await page.getByTestId('tool-select').click();
    await drag(page, at(view, LAYOUT.box.a), at(view, LAYOUT.box.b), 10);
    await expect
      .poll(() => readSelection(page))
      .toEqual({ group: true, ids: [left, right].sort() });

    const text = await annotationsText(page);
    // From the left rectangle's body, 57 px right and 41 down.
    const from = at(view, { x: 350, y: 290 });
    await drag(page, from, { x: from.x + 57, y: from.y + 41 }, 8);
    await settle(page, text);

    const after = await readAnnotations(page);
    const s = scaleOf(view);
    for (const id of [left, right]) {
      const was = originOf(before, id);
      const now = originOf(after, id);
      expect(now.x, `${id} moved right`).toBeCloseTo(was.x + 57 / s, 1);
      expect(now.y, `${id} moved down`).toBeCloseTo(was.y + 41 / s, 1);
    }
    expect(JSON.stringify(after.find((a) => a.id === mask)), 'the stored mask').toBe(storedMask);
    expect(await placementOf(page, mask), 'the painted mask').toEqual(maskPlacement);

    // Rebuilt from state, it is still where its pixels are.
    const cell = page.locator('[data-annotation-count]').first();
    await page.getByTestId('filmstrip-item-portrait').click();
    await expect(cell).toHaveAttribute('data-annotation-count', '0');
    await page.getByTestId('filmstrip-item-landscape').click();
    await expect(cell).toHaveAttribute('data-annotation-count', '3');
    await waitForStableView(page);
    await settle(page);
    expect(await placementOf(page, mask), 'the mask after a rebuild').toEqual(maskPlacement);
  });
});
