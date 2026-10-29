/**
 * The Import JSON panel refuses a document in which an annotation's saved
 * Fabric payload is not the kind of shape its geometry describes, or its
 * `toolType` is not a tool that draws that shape, and loads none of it.
 *
 * The payload (`rawAnnotationData`) is what is painted; the geometry is what
 * is measured, labelled and exported. An export edited by hand, or written by
 * another tool, can pair a rectangle's geometry with a circle's payload: the
 * user would see a circle and every measurement would describe a rectangle
 * nobody sees. It can also record a rectangle as drawn by the line tool, and
 * constraints count by `toolType`: the rectangle would use up one of the
 * context's lines and free one of its rectangles. `deserialize` now rejects
 * both, and the dev app reports the rejection the way it reports any import
 * error, with an alert, leaving the panel open so the text can be fixed.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';
import {
  alphasAt,
  annotationsText,
  deselect,
  drag,
  drawRectangle,
  imageToCanvas,
  imageToPage,
  onPixel,
  openAnnotator,
  paintedBounds,
  readAnnotations,
  referenceCentre,
  settle,
  type Point,
  type View,
} from './rectangle/helpers.js';

type Exported = Record<string, unknown> & {
  readonly id: string;
  readonly toolType: string;
  readonly geometry: { readonly type: string };
  readonly rawAnnotationData: {
    readonly format: string;
    readonly fabricVersion: string;
    readonly data: Record<string, unknown>;
  };
};

/** The document the app would export now: `serialize` of the stored annotations. */
async function exportDocument(page: Page): Promise<Exported[]> {
  return page.evaluate(() =>
    (window as unknown as { __osdTest: { serialize: () => Exported[] } }).__osdTest.serialize(),
  );
}

/** Draw a circle with the circle tool: press at its centre, drag out its radius (image px). */
async function drawCircle(page: Page, view: View, centre: Point, radius: number): Promise<void> {
  await page.getByTestId('tool-circle').click();
  const before = await annotationsText(page);
  await drag(
    page,
    onPixel(imageToPage(view, centre)),
    onPixel(imageToPage(view, { x: centre.x + radius, y: centre.y })),
    6,
  );
  await settle(page, before);
}

/** Draw a line with the line tool from image point `a` to image point `b`. */
async function drawLine(page: Page, view: View, a: Point, b: Point): Promise<void> {
  await page.getByTestId('tool-line').click();
  const before = await annotationsText(page);
  await drag(page, onPixel(imageToPage(view, a)), onPixel(imageToPage(view, b)), 6);
  await settle(page, before);
}

/** Make the context at `index` of the dev app's context picker active. */
async function useContext(page: Page, index: number, label: string): Promise<void> {
  await page.selectOption('select', { index });
  await expect(page.getByTestId('status-context')).toContainText(label);
}

/** Paste `json` into the Import JSON panel and confirm. */
async function submitImport(page: Page, json: string): Promise<void> {
  await page.getByRole('button', { name: 'Import JSON' }).first().click();
  await page.getByPlaceholder('Paste exported JSON here...').fill(json);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

test.describe('Import JSON: payload and geometry must agree', () => {
  test('a rectangle whose saved payload is a circle is refused, and nothing is loaded', async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });

    const view = await openAnnotator(page);
    const rectangle = await drawRectangle(page, view, { x: 200, y: 200 }, { x: 400, y: 320 });
    const circleCentre = { x: 800, y: 450 };
    await drawCircle(page, view, circleCentre, 80);
    await deselect(page);

    const exported = await exportDocument(page);
    expect(exported.map((a) => a.geometry.type).sort()).toEqual(['circle', 'rectangle']);
    const circle = exported.find((a) => a.geometry.type === 'circle')!;
    // The export, hand-edited: the rectangle keeps its geometry but takes the
    // circle's saved Fabric payload.
    const edited = exported.map((a) =>
      a.id === rectangle.id
        ? {
            ...a,
            rawAnnotationData: {
              ...circle.rawAnnotationData,
              data: { ...circle.rawAnnotationData.data, id: a.id },
            },
          }
        : a,
    );

    const storedBefore = await annotationsText(page);
    const paintedBefore = await paintedBounds(page);
    expect(paintedBefore, 'both shapes are painted before the import').not.toBeNull();
    const probes = [
      imageToCanvas(view, referenceCentre(rectangle.geometry)),
      imageToCanvas(view, circleCentre),
    ];
    const alphasBefore = await alphasAt(page, probes);
    expect(
      alphasBefore.every((a) => a > 0),
      'both shapes are filled at their centres',
    ).toBe(true);

    await submitImport(page, JSON.stringify(edited, null, 2));

    await expect
      .poll(() => dialogs, { message: 'no import error was shown', timeout: 5000 })
      .toEqual([
        `Import failed: Validation failed: Annotation "${rectangle.id}" has rectangle geometry, but its rawAnnotationData is a Fabric Circle, not a Rect`,
      ]);
    // The panel stays open, so the text can be fixed.
    await expect(page.getByPlaceholder('Paste exported JSON here...')).toBeVisible();

    // Nothing was loaded: the stored annotations and the painted canvas are
    // as they were.
    await settle(page);
    expect(await annotationsText(page)).toBe(storedBefore);
    expect(await paintedBounds(page)).toEqual(paintedBefore);
    expect(await alphasAt(page, probes)).toEqual(alphasBefore);

    // The same document without the edit loads through the same panel.
    await submitImport(page, JSON.stringify(exported, null, 2));
    await expect(page.getByPlaceholder('Paste exported JSON here...')).toBeHidden();
    await settle(page);
    expect(dialogs, 'the unedited export was refused').toHaveLength(1);
    const reloaded = await readAnnotations(page);
    expect(reloaded.map((a) => a.id).sort()).toEqual(exported.map((a) => a.id).sort());
    expect(await paintedBounds(page)).toEqual(paintedBefore);
  });
});

test.describe('Import JSON: the toolType must draw the geometry', () => {
  test('a rectangle recorded as drawn by the line tool is refused, and the quotas are untouched', async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });

    const view = await openAnnotator(page);
    // Fracture allows 2 rectangles and 3 lines per image.
    await useContext(page, 0, 'Fracture');
    const rectTool = page.getByTestId('tool-rectangle');
    const lineTool = page.getByTestId('tool-line');
    const rectangle = await drawRectangle(page, view, { x: 200, y: 200 }, { x: 400, y: 320 });
    await drawLine(page, view, { x: 600, y: 300 }, { x: 900, y: 500 });
    await deselect(page);
    await expect(rectTool).toContainText('Rect 1/2');
    await expect(lineTool).toContainText('Line 1/3');

    const exported = await exportDocument(page);
    expect(exported.map((a) => [a.toolType, a.geometry.type]).sort()).toEqual([
      ['line', 'line'],
      ['rectangle', 'rectangle'],
    ]);
    // The export, hand-edited: the rectangle is recorded as drawn by the line
    // tool. Loaded, it would count as Fracture's second line and leave both
    // rectangles free.
    const edited = exported.map((a) => (a.id === rectangle.id ? { ...a, toolType: 'line' } : a));

    const storedBefore = await annotationsText(page);
    const paintedBefore = await paintedBounds(page);
    expect(paintedBefore, 'both shapes are painted before the import').not.toBeNull();
    const probe = [imageToCanvas(view, referenceCentre(rectangle.geometry))];
    const alphaBefore = await alphasAt(page, probe);
    expect(alphaBefore[0], 'the rectangle is filled at its centre').toBeGreaterThan(0);

    await submitImport(page, JSON.stringify(edited, null, 2));

    await expect
      .poll(() => dialogs, { message: 'no import error was shown', timeout: 5000 })
      .toEqual([
        `Import failed: Validation failed: Annotation "${rectangle.id}" has rectangle geometry, but its toolType is "line", not "rectangle"`,
      ]);
    // The panel stays open, so the text can be fixed.
    await expect(page.getByPlaceholder('Paste exported JSON here...')).toBeVisible();

    // Nothing was loaded: the stored annotations, the painted canvas and the
    // quotas are as they were.
    await settle(page);
    expect(await annotationsText(page)).toBe(storedBefore);
    expect(await paintedBounds(page)).toEqual(paintedBefore);
    expect(await alphasAt(page, probe)).toEqual(alphaBefore);
    await expect(rectTool).toContainText('Rect 1/2');
    await expect(lineTool).toContainText('Line 1/3');

    // The same document without the edit loads through the same panel.
    await submitImport(page, JSON.stringify(exported, null, 2));
    await expect(page.getByPlaceholder('Paste exported JSON here...')).toBeHidden();
    await settle(page);
    expect(dialogs, 'the unedited export was refused').toHaveLength(1);
    const reloaded = await readAnnotations(page);
    expect(reloaded.map((a) => a.id).sort()).toEqual(exported.map((a) => a.id).sort());
    expect(await paintedBounds(page)).toEqual(paintedBefore);
    await expect(rectTool).toContainText('Rect 1/2');
    await expect(lineTool).toContainText('Line 1/3');
  });
});
