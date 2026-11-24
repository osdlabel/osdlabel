/**
 * The Leptos app driving osdlabel, end to end: every control is a real button,
 * so the checks go through clicks, keys and the canvas, and read state from
 * the DOM and from the bridge's snapshot (what the app itself renders from).
 */
import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '@osdlabel/shell-bridge/snapshot';

interface PocWindow {
  __poc: { bridge: { getSnapshot(): string; dispatch(json: string): string } | null };
}

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(
    () => JSON.parse((window as unknown as PocWindow).__poc.bridge!.getSnapshot()) as Snapshot,
  );

const tools = async (page: Page) => (await snapshot(page)).annotations.map((a) => a.tool);
const status = (page: Page) => page.getByTestId('status');

async function openApp(page: Page): Promise<void> {
  // Playwright intercepts file pickers only once a listener exists, and
  // turning that on is asynchronous: register it before anything can open one.
  page.on('filechooser', () => {});
  await page.goto('/');
  await expect(status(page)).toHaveText(/Ready/);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as PocWindow).__poc.bridge !== null))
    .toBe(true);
  await expect.poll(async () => (await snapshot(page)).activeImageId).toBe('landscape');
}

async function viewerBox(page: Page) {
  const box = await page.getByTestId('viewer').boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** A drag inside the viewer, in fractions of its size. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const v = await viewerBox(page);
  await page.mouse.move(v.x + v.width * from[0], v.y + v.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(v.x + v.width * to[0], v.y + v.height * to[1], { steps: 8 });
  await page.mouse.up();
}

async function clickViewer(page: Page, at: [number, number]): Promise<void> {
  const v = await viewerBox(page);
  await page.mouse.click(v.x + v.width * at[0], v.y + v.height * at[1]);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('the viewer is part of the layout and fills its pane, also after a resize', async ({
  page,
}) => {
  // osdlabel's grid (the viewer's only child) fills the pane, inside its
  // 1px border; each cell then draws its own border and gap.
  const gap = async () => {
    const v = await viewerBox(page);
    const grid = await page.locator('[data-testid=viewer] > *').first().boundingBox();
    expect(grid).not.toBeNull();
    return Math.max(Math.abs(grid!.width - v.width), Math.abs(grid!.height - v.height));
  };
  expect(await gap()).toBeLessThanOrEqual(2);
  await expect(page.locator('[data-testid=viewer] .openseadragon-container')).toHaveCount(1);

  await page.setViewportSize({ width: 900, height: 640 });
  await expect.poll(async () => (await viewerBox(page)).width).toBeLessThan(700);
  expect(await gap()).toBeLessThanOrEqual(2);
  // OSD follows its cell: its canvas is no wider than the shrunken pane.
  await expect
    .poll(async () => {
      const osd = await page.locator('[data-testid=viewer] .openseadragon-container').boundingBox();
      return osd!.width;
    })
    .toBeLessThanOrEqual((await viewerBox(page)).width);
});

test('a context limit disables the tool button, and its key says why', async ({ page }) => {
  await page.keyboard.press('1');
  await expect(page.getByTestId('tool-rectangle')).toHaveAttribute('aria-pressed', 'true');
  await drag(page, [0.2, 0.2], [0.35, 0.4]);
  await drag(page, [0.5, 0.2], [0.65, 0.4]);
  await expect.poll(() => tools(page)).toEqual(['rectangle', 'rectangle']);

  const rectangle = page.getByTestId('tool-rectangle');
  await expect(rectangle).toBeDisabled();
  await expect(rectangle).toContainText('2/2');
  await expect(page.getByTestId('tool-circle')).toBeDisabled();

  await page.keyboard.press('1');
  await expect(status(page)).toHaveText('Rectangle is not available in this context');
});

test('clicking a tool button selects it, and the canvas draws with it', async ({ page }) => {
  await page.getByTestId('tool-line').click();
  await expect.poll(async () => (await snapshot(page)).activeTool).toBe('line');
  await drag(page, [0.2, 0.7], [0.6, 0.8]);
  await expect.poll(() => tools(page)).toEqual(['line']);
  await expect(page.getByTestId('tool-line')).toContainText('1/3');
  await expect(page.getByTestId('image-landscape')).toContainText('1');
});

test('keys reach the drawing tool first, then the app', async ({ page }) => {
  await page.getByTestId('context-ctx-3').click();
  await expect(page.getByTestId('context-ctx-3')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('5');
  await expect.poll(async () => (await snapshot(page)).activeTool).toBe('polyline');

  const points: [number, number][] = [
    [0.3, 0.5],
    [0.4, 0.4],
    [0.5, 0.55],
  ];
  for (const p of points) await clickViewer(page, p);
  // Escape cancels the polyline in progress; the app never sees it.
  await page.keyboard.press('Escape');
  expect(await snapshot(page)).toMatchObject({ activeTool: 'polyline', annotations: [] });

  for (const p of points) await clickViewer(page, p);
  await page.keyboard.press('Enter');
  await expect.poll(() => tools(page)).toEqual(['polyline']);

  // With nothing in progress, Escape is the app's: back to navigation.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-navigate')).toHaveAttribute('aria-pressed', 'true');
});

test('arrows select through the list, and Delete removes the selection', async ({ page }) => {
  await page.keyboard.press('3');
  await drag(page, [0.2, 0.3], [0.4, 0.3]);
  await drag(page, [0.2, 0.6], [0.4, 0.6]);
  await expect.poll(() => tools(page)).toEqual(['line', 'line']);
  const [first, second] = (await snapshot(page)).annotations;
  await page.keyboard.press('n'); // leave the tool, so the canvas has no gesture

  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId(`annotation-${first!.id}`)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId(`annotation-${second!.id}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('delete')).toBeEnabled();
  await page.getByTestId('delete').click();
  await expect
    .poll(async () => (await snapshot(page)).annotations.map((a) => a.id))
    .toEqual([first!.id]);
  await expect(page.getByTestId('delete')).toBeDisabled();
});

test('undo and redo, by button and by key', async ({ page }) => {
  await expect(page.getByTestId('undo')).toBeDisabled();
  await page.keyboard.press('3');
  await drag(page, [0.2, 0.3], [0.4, 0.3]);
  await drag(page, [0.2, 0.6], [0.4, 0.6]);
  await expect.poll(() => tools(page)).toHaveLength(2);

  await page.getByTestId('undo').click();
  await expect.poll(() => tools(page)).toHaveLength(1);
  await page.keyboard.press('u');
  await expect.poll(() => tools(page)).toHaveLength(0);
  await expect(page.getByTestId('undo')).toBeDisabled();
  await expect(page.getByTestId('redo')).toBeEnabled();

  await page.keyboard.press('U');
  await expect.poll(() => tools(page)).toHaveLength(1);
  await page.getByTestId('redo').click();
  await expect.poll(() => tools(page)).toHaveLength(2);
  await expect(page.getByTestId('redo')).toBeDisabled();
});

test('export, then import, round-trips the annotations', async ({ page }, testInfo) => {
  await page.keyboard.press('3');
  await drag(page, [0.2, 0.3], [0.4, 0.3]);
  await expect.poll(() => tools(page)).toEqual(['line']);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export').click(),
  ]);
  expect(download.suggestedFilename()).toBe('annotations.json');
  const exported = testInfo.outputPath('annotations.json');
  await download.saveAs(exported);

  await page.keyboard.press('u');
  await expect.poll(() => tools(page)).toEqual([]);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import').click(),
  ]);
  await chooser.setFiles(exported);
  await expect.poll(() => tools(page)).toEqual(['line']);
  await expect(status(page)).toHaveText('Imported 1 annotation(s) from annotations.json');

  const [again] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('o')]);
  await again.setFiles(`${testInfo.project.testDir}/fixtures/invalid.json`);
  await expect(status(page)).toHaveText(/^Import failed: /);
  expect(await tools(page)).toEqual(['line']);
});

test('grid buttons and keys change the layout; arrows move between cells', async ({ page }) => {
  await page.getByTestId('grid-2x1').click();
  await expect(page.getByTestId('grid-2x1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid=viewer] .openseadragon-container')).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('viewer-title')).toHaveText('Portrait · cell 2/2 (2×1)');
  await expect(page.getByTestId('image-portrait')).toHaveAttribute('aria-current', 'true');

  await page.keyboard.press('g');
  await expect(page.locator('[data-testid=viewer] .openseadragon-container')).toHaveCount(4);
  await page.getByTestId('view-rotateCw').click();
  await expect(page.getByTestId('transform')).toHaveText('90°');
});

test('the help dialog opens above the viewer, takes focus, and closes', async ({ page }) => {
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  // Nothing of the viewer is clickable through it.
  const v = await viewerBox(page);
  const onTop = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('.backdrop') !== null,
    [v.x + v.width / 2, v.y + v.height / 2] as const,
  );
  expect(onTop).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A shortcut closes it as it acts.
  await page.getByTestId('help-button').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('r');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('transform')).toHaveText('90°');
});

test('a focused button keeps focus as snapshots re-render, and owns Enter', async ({ page }) => {
  const line = page.getByTestId('tool-line');
  await line.focus();
  await page.keyboard.press('Enter');
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await expect(line).toBeFocused();
  // Enter went to the button, not to a shortcut: the status is the tool's.
  await expect(status(page)).toHaveText('Tool: line');

  const grid = page.getByTestId('grid-2x2');
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'true');
  await expect(grid).toBeFocused();
});

test('the bridge rejects a malformed command and says why', async ({ page }) => {
  const reply = await page.evaluate(() =>
    (window as unknown as PocWindow).__poc.bridge!.dispatch('{"t":"grid","columns":9,"rows":1}'),
  );
  expect(reply).toMatch(/^Rejected command: /);
  expect((await snapshot(page)).grid).toEqual({ columns: 1, rows: 1 });
});

test('loads nothing from off the dev server', async ({ page }) => {
  const offOrigin: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol.startsWith('http')) {
      offOrigin.push(r.url());
    }
  });
  await page.reload();
  await expect(status(page)).toHaveText(/Ready/);
  for (const id of ['portrait', 'wide', 'tiled']) {
    await page.getByTestId(`image-${id}`).click();
    await expect.poll(async () => (await snapshot(page)).activeImageId).toBe(id);
  }
  await page.waitForTimeout(500);
  expect(offOrigin).toEqual([]);
});
