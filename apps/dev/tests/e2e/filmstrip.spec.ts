import { test, expect, type Page } from '@playwright/test';

test.describe('Filmstrip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="filmstrip"]', { timeout: 10000 });
  });

  test('should display all available images', async ({ page }) => {
    await expect(page.getByTestId('filmstrip-item-landscape')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-portrait')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-wide')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-tiled')).toBeVisible();
  });

  test('should assign image to active cell on click', async ({ page }) => {
    // Cell 0 starts with Landscape. Click Portrait to change it.
    await page.getByTestId('filmstrip-item-portrait').click();

    // Verify no placeholder (image was assigned)
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
  });

  test('should highlight assigned images', async ({ page }) => {
    // Landscape is assigned to cell 0, which is also the active cell.
    const landscapeItem = page.getByTestId('filmstrip-item-landscape');
    await expect(landscapeItem).toHaveAttribute('data-assignment', 'active');
    const border = await landscapeItem.evaluate((el) => getComputedStyle(el).borderColor);
    // The assigned image should have the blue highlight border
    expect(border).toContain('rgb(33, 150, 243)'); // #2196F3
  });

  test('should assign different images to different cells', async ({ page }) => {
    // Switch to a 2x1 grid
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // Activate the empty cell 1 and give it its own image.
    await page.getByTestId('cell-placeholder-1').click();
    await page.getByTestId('filmstrip-item-portrait').click();

    // Both cells should now have images
    await expect(page.locator('text=Assign an image')).toHaveCount(0);

    // Both are assigned, but to different cells — and cell 1 is the active one.
    // Portrait reads as 'active' (its cell is the one the clear badge acts on);
    // Landscape reads as 'other' (in use, but in a cell this strip cannot act on).
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'other',
    );
  });

  test('the clear badge empties the active cell', async ({ page }) => {
    const landscape = page.getByTestId('filmstrip-item-landscape');
    const clear = page.getByTestId('filmstrip-clear-landscape');

    // Cell 0 starts assigned to Landscape and active, so it offers the badge.
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
    await expect(clear).toBeVisible();
    await expect(page.locator('text=Assign an image')).toHaveCount(0);

    await clear.click();

    // The cell returns to the empty state every cell starts in. Assert the
    // specific cell, not a global placeholder count — a count cannot tell
    // "cell 0 was cleared" from "some other cell was cleared instead".
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
    await expect(landscape).toHaveAttribute('data-assignment', 'none');
    await expect(clear).toHaveCount(0);

    // And the round trip works: clicking the thumbnail re-assigns.
    await landscape.click();
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
    // The rebuilt cell is a live viewer, not just restored markup.
    await expect(page.locator('.openseadragon-canvas')).toHaveCount(1);
  });

  test('a thumbnail click never clears, however many times it is clicked', async ({ page }) => {
    // The reason the clear is a separate control. Clicking a thumbnail assigns,
    // which makes it 'active' — so if the thumbnail also cleared, the second
    // click of an ordinary double-click would empty the cell and silently drop
    // its rotation, flip, exposure and contrast, with no undo.
    const portrait = page.getByTestId('filmstrip-item-portrait');

    await portrait.click();
    await expect(portrait).toHaveAttribute('data-assignment', 'active');

    await portrait.dblclick();

    // Still assigned. A double-click is two assigns, not assign-then-clear.
    await expect(portrait).toHaveAttribute('data-assignment', 'active');
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);

    // And a plain repeat click is still just a re-assign.
    await portrait.click();
    await expect(portrait).toHaveAttribute('data-assignment', 'active');
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
  });

  test('the clear badge is reachable and operable from the keyboard', async ({ page }) => {
    // The badge is the only control here that loses work, so it is the one that
    // most needs a non-mouse path.
    const clear = page.getByTestId('filmstrip-clear-landscape');
    await expect(clear).toBeVisible();

    await clear.focus();
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'none',
    );
  });

  test('an image assigned to another cell offers no clear badge', async ({ page }) => {
    // The regression the tri-state border exists to prevent: a highlighted
    // thumbnail belonging to a different cell must not look like it can be
    // cleared from here, because this strip only ever acts on the active cell.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // Make the empty cell 1 active.
    await page.getByTestId('cell-placeholder-1').click();

    const landscape = page.getByTestId('filmstrip-item-landscape');
    await expect(landscape).toHaveAttribute('data-assignment', 'other');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toHaveCount(0);

    await landscape.click();

    // Landscape is now in both cells; nothing was cleared.
    await expect(page.locator('text=Assign an image')).toHaveCount(0);
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
  });

  test('clears the ACTIVE cell, not cell 0, when a later cell is active', async ({ page }) => {
    // Every other clear path runs with cell 0 active, so a filmstrip that
    // cleared the wrong index — hardcoded 0, or any stale index — would pass
    // the rest of this suite untouched.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();

    // Activate the empty cell 1 and give it its own image.
    await page.getByTestId('cell-placeholder-1').click();
    await page.getByTestId('filmstrip-item-portrait').click();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );

    await page.getByTestId('filmstrip-clear-portrait').click();

    // Cell 1 is empty and cell 0 is untouched.
    await expect(page.getByTestId('cell-placeholder-1')).toBeVisible();
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'other',
    );
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'none',
    );
  });

  test('clears a bottom-row cell on a multi-row grid', async ({ page }) => {
    // Every other filmstrip test uses a 2x1 grid, where rows == 1 and the cell
    // count equals the column count, so nothing there can tell a cell-count
    // derivation that forgot `gridRows` from a correct one.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-2').click();

    // Reach cell 3 by its shortcut rather than by clicking the placeholder.
    // The shortcut is screened against `getGridCellCount`, so a count that
    // dropped `gridRows` would refuse `4` here and the rest of this test would
    // act on the wrong cell — which clicking the placeholder directly would
    // not catch.
    await page.keyboard.press('4');
    await expect(page.getByTestId('grid-cell-3')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('filmstrip-item-portrait').click();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );

    await page.getByTestId('filmstrip-clear-portrait').click();

    await expect(page.getByTestId('cell-placeholder-3')).toBeVisible();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'none',
    );
    // Cell 0 keeps its seeded image throughout.
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
  });

  test('a cell-selection shortcut past the end of the grid is ignored', async ({ page }) => {
    // The shortcuts map each digit to a fixed cell index, so they have to be
    // screened against the grid. On the default 1x1 grid, letting `9` through
    // would leave the active cell offscreen: the clear badge disappears with no
    // visible cause, and every thumbnail click writes an assignment nobody can
    // see until the grid grows.
    const landscape = page.getByTestId('filmstrip-item-landscape');
    await expect(landscape).toHaveAttribute('data-assignment', 'active');

    await page.keyboard.press('9');

    // Still acting on cell 0, so the clear badge is still offered.
    await expect(landscape).toHaveAttribute('data-assignment', 'active');
    await expect(page.getByTestId('filmstrip-clear-landscape')).toBeVisible();

    // And it clears the visible cell rather than a phantom one.
    await page.getByTestId('filmstrip-clear-landscape').click();
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
  });

  test('renders the three assignment states distinguishably', async ({ page }) => {
    // The tri-state border is what makes the clear badge's absence meaningful.
    // If 'other' rendered like 'active', the misleading highlight this change
    // set out to remove would be back, and every state assertion above would
    // still pass.
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();
    await page.getByTestId('cell-placeholder-1').click();
    await page.getByTestId('filmstrip-item-portrait').click();

    const borderOf = (id: string) =>
      page.getByTestId(`filmstrip-item-${id}`).evaluate((el) => getComputedStyle(el).borderColor);

    // portrait = active (cell 1), landscape = other (cell 0), wide = none.
    const [active, other, none] = await Promise.all([
      borderOf('portrait'),
      borderOf('landscape'),
      borderOf('wide'),
    ]);

    expect(new Set([active, other, none]).size).toBe(3);
  });
});

/** Ids of every annotation committed to state, across images. */
const committedAnnotationIds = async (page: Page): Promise<string[]> => {
  const text = (await page.getByTestId('annotations-json').textContent()) ?? '{}';
  const byImage = JSON.parse(text) as Record<string, Record<string, unknown>>;
  return Object.values(byImage).flatMap((forImage) => Object.keys(forImage));
};

const activeTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

test.describe('Filmstrip from the keyboard and assistive tech (#189)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="filmstrip"]', { timeout: 10000 });
  });

  test('a thumbnail is a focusable button that Enter assigns', async ({ page }) => {
    const portrait = page.getByTestId('filmstrip-item-portrait');
    await expect(portrait).toHaveAttribute('data-assignment', 'none');

    const thumb = page.getByTestId('filmstrip-thumb-portrait');
    await thumb.focus();
    await expect(thumb).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(portrait).toHaveAttribute('data-assignment', 'active');
  });

  test('Space assigns too', async ({ page }) => {
    const thumb = page.getByTestId('filmstrip-thumb-wide');
    await thumb.focus();
    await page.keyboard.press(' ');

    await expect(page.getByTestId('filmstrip-item-wide')).toHaveAttribute(
      'data-assignment',
      'active',
    );
  });

  test('each thumbnail is named with its image and assignment state', async ({ page }) => {
    // The tri-state border is visual only; the accessible name carries the
    // same three states, and only the active one is marked current.
    const landscape = page.getByRole('button', { name: 'Landscape, shown in the active cell' });
    const portrait = page.getByRole('button', { name: 'Portrait, not shown' });
    await expect(landscape).toHaveAttribute('aria-current', 'true');
    await expect(portrait).not.toHaveAttribute('aria-current', /.*/);

    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-2-1').click();
    await page.getByTestId('cell-placeholder-1').click();

    // Landscape is still in cell 0, which is no longer the active cell.
    await expect(
      page.getByRole('button', { name: 'Landscape, shown in another cell' }),
    ).toHaveCount(1);
  });

  test('a mouse click does not leave focus on the thumbnail', async ({ page }) => {
    // Like the toolbar: a focused thumbnail would be re-pressed by Enter, which
    // is also the polyline-finish key.
    await page.getByTestId('filmstrip-item-portrait').click();
    await expect(page.getByTestId('filmstrip-item-portrait')).toHaveAttribute(
      'data-assignment',
      'active',
    );
    expect(await activeTestId(page)).not.toBe('filmstrip-thumb-portrait');
  });

  test('clearing from the keyboard moves focus to that image’s thumbnail', async ({ page }) => {
    // The clear button unmounts with the assignment; without a hand-off, focus
    // fell to <body> and a keyboard user had to tab back from the top.
    const clear = page.getByTestId('filmstrip-clear-landscape');
    await clear.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
    await expect(page.getByTestId('filmstrip-thumb-landscape')).toBeFocused();

    // And Enter there puts the image straight back.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cell-placeholder-0')).toHaveCount(0);
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'active',
    );
  });

  test('a mouse clear leaves focus where it was', async ({ page }) => {
    await page.getByTestId('filmstrip-clear-landscape').click();
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
    expect(await activeTestId(page)).not.toBe('filmstrip-thumb-landscape');
  });

  test('Enter on the focused clear button does not also finish a polyline', async ({ page }) => {
    // The bug in #189: the window-level shortcut listener saw the same Enter
    // that activated the button, and Enter is the polyline-finish key. One
    // keypress finished the polyline *and* emptied the cell.
    await page.getByRole('combobox').selectOption({ label: 'General' });
    await page.getByTestId('tool-polyline').click();

    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no layout box');
    await page.mouse.click(box.x + 100, box.y + 100);
    await page.mouse.click(box.x + 200, box.y + 120);
    await page.mouse.click(box.x + 260, box.y + 200);
    await page.waitForTimeout(200);
    expect(await committedAnnotationIds(page)).toHaveLength(0);

    const clear = page.getByTestId('filmstrip-clear-landscape');
    await clear.focus();
    await page.keyboard.press('Enter');

    // The button did its job...
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
    // ...and nothing else: the in-progress polyline was not committed.
    await page.waitForTimeout(200);
    expect(await committedAnnotationIds(page)).toHaveLength(0);
  });

  test('control: Enter with focus off any button does finish the polyline', async ({ page }) => {
    // Proves the test above can fail: the same drawing, finished by an Enter
    // that no button owns, commits the polyline.
    await page.getByRole('combobox').selectOption({ label: 'General' });
    await page.getByTestId('tool-polyline').click();

    const canvas = page.locator('canvas.upper-canvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no layout box');
    await page.mouse.click(box.x + 100, box.y + 100);
    await page.mouse.click(box.x + 200, box.y + 120);
    await page.mouse.click(box.x + 260, box.y + 200);
    await page.waitForTimeout(200);

    // No button owns this Enter: the tool was picked with the mouse, so focus
    // never landed on it. (The drawing presses also move focus to the viewer,
    // but this control does not depend on that; toolbar-focus.spec.ts covers
    // a Tab-picked tool.)
    await page.keyboard.press('Enter');

    await expect.poll(() => committedAnnotationIds(page)).toHaveLength(1);
  });
});

test.describe('Filmstrip markup and targets (#205)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="filmstrip"]', { timeout: 10000 });
  });

  test('is announced as a labelled list with one item per image', async ({ page }) => {
    // Assistive tech used to read a flat run of buttons, with nothing saying
    // what they belonged to or how many there were.
    const list = page.getByRole('list', { name: 'Images' });
    await expect(list).toHaveAttribute('data-testid', 'filmstrip');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(
      list.getByRole('listitem').filter({ has: page.getByTestId('filmstrip-thumb-portrait') }),
    ).toHaveCount(1);
  });

  test('holds only phrasing content inside a thumbnail button', async ({ page }) => {
    // The dev images have no thumbnailUrl, so every thumbnail shows the text
    // placeholder, which used to be a <div> inside the <button>.
    const thumb = page.getByTestId('filmstrip-thumb-portrait');
    await expect(thumb).toHaveText('Portrait');
    expect(await thumb.locator('div').count()).toBe(0);
    // Still filling the button, so the layout is unchanged.
    const placeholder = await thumb.locator('span').first().boundingBox();
    const button = await thumb.boundingBox();
    expect(placeholder).not.toBeNull();
    expect(button).not.toBeNull();
    expect(placeholder!.width).toBeCloseTo(button!.width, 0);
    expect(placeholder!.height).toBeCloseTo(button!.height, 0);
  });

  test('gives the clear badge at least a 24px target', async ({ page }) => {
    // WCAG 2.5.8: the badge drawn is 16px, the button around it is 24px.
    const clear = page.getByTestId('filmstrip-clear-landscape');
    const box = await clear.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);

    // A press in the target but outside the drawn badge still clears.
    await page.mouse.click(box!.x + 2, box!.y + box!.height - 2);
    await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
  });
});

test.describe('Re-assigning the image a cell already shows (#212)', () => {
  const readRotation = (page: Page): Promise<number | null> =>
    page.evaluate(() => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdViewer?: { viewport?: { getRotation: () => number } } })
        | null;
      return el?.__osdViewer?.viewport?.getRotation() ?? null;
    });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="filmstrip"]', { timeout: 10000 });
    await expect(page.getByTestId('filmstrip-item-landscape')).toHaveAttribute(
      'data-assignment',
      'active',
    );
    await page.keyboard.press('Shift+R');
    await expect.poll(() => readRotation(page)).toBe(90);
  });

  test('a click on the active cell’s own thumbnail keeps its view', async ({ page }) => {
    // Used to reset rotation, flip, negative, exposure and contrast, with
    // nothing else visibly changing.
    await page.getByTestId('filmstrip-thumb-landscape').click();
    await page.waitForTimeout(300);
    expect(await readRotation(page)).toBe(90);
  });

  test('Enter on the focused active thumbnail keeps its view too', async ({ page }) => {
    await page.getByTestId('filmstrip-thumb-landscape').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await readRotation(page)).toBe(90);
  });

  test('assigning a different image still starts from a fresh view', async ({ page }) => {
    await page.getByTestId('filmstrip-thumb-portrait').click();
    await expect.poll(() => readRotation(page)).toBe(0);
  });
});
