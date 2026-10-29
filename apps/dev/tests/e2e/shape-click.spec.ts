/**
 * A click with the rectangle, circle or line tool draws nothing. Neither does
 * a drag whose shape would be under `MIN_SHAPE_SCREEN_PX` (3 screen px) on
 * screen, at any zoom. A small real drag still draws.
 *
 * Until this was fixed, a click committed a zero-size annotation. It painted
 * nothing, yet it carried a badge and labels at the empty spot, could be
 * selected only by clicking that spot, and counted toward the context's
 * `maxCount`: two stray clicks used up Fracture's two rectangles while the
 * image showed none.
 *
 * Paint is judged from Fabric's lower canvas, pixel by pixel, as the
 * rectangle suite does.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  annotationsText,
  drag,
  openAnnotator,
  paintedBounds,
  readAnnotations,
  scaleOf,
  settle,
  storedStrokeWidth,
  type Bounds,
  type Point,
  type View,
} from './rectangle/helpers.js';

/** Every annotation-anchored decoration: text labels and the dev app's DOM badges. */
const ANNOTATION_DECORATIONS =
  '[data-osdlabel="decoration-text"]:not([data-decoration-id="hud:ratio"]), [data-osdlabel-test="dom-badge"]';

const TOOLS = [
  { type: 'rectangle', label: 'Rect' },
  { type: 'circle', label: 'Circle' },
  { type: 'line', label: 'Line' },
] as const;

type ToolType = (typeof TOOLS)[number]['type'];

/**
 * Page-px drags just under and comfortably over the 3 px minimum, as each tool
 * measures it: a rectangle's shorter side (2, then 4), a circle's diameter (a
 * circle's drag is its radius: 2, then 4), a line's length (2.24, then 4.24).
 */
const DRAGS: Record<ToolType, { readonly under: Point; readonly over: Point }> = {
  rectangle: { under: { x: 2, y: 2 }, over: { x: 4, y: 4 } },
  circle: { under: { x: 1, y: 0 }, over: { x: 2, y: 0 } },
  line: { under: { x: 2, y: 1 }, over: { x: 3, y: 3 } },
};

/**
 * A page point `dx`, `dy` CSS px from the centre of the canvas, on a whole
 * pixel. Every view these specs use shows image there.
 */
function spot(view: View, dx: number, dy: number): Point {
  return {
    x: Math.round(view.canvasOrigin.x + view.canvasSize.width / 2 + dx),
    y: Math.round(view.canvasOrigin.y + view.canvasSize.height / 2 + dy),
  };
}

async function useContext(page: Page, index: number, label: string): Promise<void> {
  await page.selectOption('select', { index });
  await expect(page.getByTestId('status-context')).toContainText(label);
}

/** Nothing is stored, painted on the canvas, or decorated. */
async function expectNothingDrawn(page: Page, what: string): Promise<void> {
  await settle(page);
  expect(await readAnnotations(page), `${what}: stored`).toEqual([]);
  expect(await paintedBounds(page), `${what}: painted`).toBeNull();
  await expect(page.locator(ANNOTATION_DECORATIONS), `${what}: decorated`).toHaveCount(0);
}

/**
 * The box, in canvas CSS px, a shape dragged from page point `from` to `to`
 * covers once painted: the drag's box for a rectangle or a line, the circle
 * about `from` through `to`.
 */
function shapeBox(view: View, type: ToolType, from: Point, to: Point): Bounds {
  const a = { x: from.x - view.canvasOrigin.x, y: from.y - view.canvasOrigin.y };
  const b = { x: to.x - view.canvasOrigin.x, y: to.y - view.canvasOrigin.y };
  if (type === 'circle') {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    return { minX: a.x - r, minY: a.y - r, maxX: a.x + r, maxY: a.y + r };
  }
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/**
 * Drag `from` to `to` with the active tool, with nothing stored yet. The drag
 * must store one annotation, of `type`, which is decorated, and the canvas
 * must paint it where it was dragged: the painted box is the shape's box,
 * grown by up to half its stroke and 1.5 px of antialiasing.
 */
async function expectDragDraws(
  page: Page,
  view: View,
  type: ToolType,
  from: Point,
  to: Point,
): Promise<void> {
  const what = `a ${type} dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`;
  const before = await annotationsText(page);
  expect(await readAnnotations(page), 'nothing may be stored before the drag').toEqual([]);
  await drag(page, from, to, 3);
  await settle(page, before);
  const all = await readAnnotations(page);
  expect(all, `${what}: stored`).toHaveLength(1);
  expect(all[0]!.geometry.type, `${what}: stored`).toBe(type);
  // So the empty count after a click means something: the selector finds a
  // drawn shape's decorations.
  await expect(page.locator(ANNOTATION_DECORATIONS), `${what}: decorated`).not.toHaveCount(0);

  const halfStroke = ((await storedStrokeWidth(page)) * scaleOf(view)) / 2;
  const expected = shapeBox(view, type, from, to);
  const painted = await paintedBounds(page);
  expect(painted, `${what}: nothing is painted`).not.toBeNull();
  const grown = halfStroke + 1.5;
  for (const side of ['minX', 'minY'] as const) {
    expect(painted![side], `${what}: painted ${side}`).toBeGreaterThanOrEqual(
      expected[side] - grown,
    );
    expect(painted![side], `${what}: painted ${side}`).toBeLessThanOrEqual(expected[side] + 1);
  }
  for (const side of ['maxX', 'maxY'] as const) {
    expect(painted![side], `${what}: painted ${side}`).toBeLessThanOrEqual(expected[side] + grown);
    expect(painted![side], `${what}: painted ${side}`).toBeGreaterThanOrEqual(expected[side] - 1);
  }
}

test.describe('A click with a drag-to-draw tool draws nothing', () => {
  test("stray clicks leave Fracture's quotas untouched, and real drags still use them", async ({
    page,
  }) => {
    const view = await openAnnotator(page);
    // Fracture allows 2 rectangles and 3 lines per image.
    await useContext(page, 0, 'Fracture');
    const rect = page.getByTestId('tool-rectangle');
    const line = page.getByTestId('tool-line');
    await expect(rect).toContainText('Rect 0/2');
    await expect(line).toContainText('Line 0/3');

    const clicks = [spot(view, -150, -80), spot(view, 0, -80), spot(view, 150, -80)] as const;
    await rect.click();
    await page.mouse.click(clicks[0].x, clicks[0].y);
    await page.mouse.click(clicks[1].x, clicks[1].y);
    await line.click();
    await page.mouse.click(clicks[2].x, clicks[2].y);
    await expectNothingDrawn(page, 'after three clicks');
    await expect(rect).toContainText('Rect 0/2');
    await expect(rect).toBeEnabled();
    await expect(line).toContainText('Line 0/3');
    await expect(line).toBeEnabled();

    // Two 6 px drags are two rectangles, and use the quota up.
    await rect.click();
    const first = spot(view, -150, 60);
    await expectDragDraws(page, view, 'rectangle', first, { x: first.x + 6, y: first.y + 6 });
    await expect(rect).toContainText('Rect 1/2');
    const second = spot(view, 0, 60);
    const before = await annotationsText(page);
    await drag(page, second, { x: second.x + 6, y: second.y + 6 }, 3);
    await settle(page, before);
    await expect(rect).toContainText('Rect 2/2');
    await expect(rect).toBeDisabled();
  });

  // The minimum is on screen, not in the image. Zoomed out to 0.5, a 2 px drag
  // spans 4 image px; zoomed in to 4.6, a 4 px drag spans under 1. A minimum
  // of 3 image px would keep the first and drop the second.
  for (const imageScale of [0.5, 4.6]) {
    for (const tool of TOOLS) {
      test(`at ${imageScale} screen px per image px, a ${tool.type} click or a drag under 3 screen px draws nothing; one over draws`, async ({
        page,
      }) => {
        const view = await openAnnotator(page, { imageScale });
        const button = page.getByTestId(`tool-${tool.type}`);
        await expect(button).toContainText(`${tool.label} 0`);
        await button.click();
        const at = spot(view, -60, -40);

        await page.mouse.click(at.x, at.y);
        await expectNothingDrawn(page, `a click with the ${tool.type} tool`);

        const { under, over } = DRAGS[tool.type];
        await drag(page, at, { x: at.x + under.x, y: at.y + under.y }, 2);
        await expectNothingDrawn(page, `a ${tool.type} drawn ${JSON.stringify(under)} px across`);
        await expect(button).toContainText(`${tool.label} 0`);

        // At the same spot, so it also shows nothing was left there to land on.
        await expectDragDraws(page, view, tool.type, at, { x: at.x + over.x, y: at.y + over.y });
        await expect(button).toContainText(`${tool.label} 1`);
      });
    }
  }
});
