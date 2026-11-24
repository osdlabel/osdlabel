/**
 * The Ratzilla shell driving osdlabel, end to end: the TUI is the only UI, so
 * every check goes through keys, clicks on terminal cells, or the canvas.
 *
 * State is read from the bridge's snapshot (what the shell itself draws from)
 * and the TUI's own text, found in Ratzilla's DOM grid.
 */
import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '@osdlabel/shell-bridge/snapshot';

interface PocWindow {
  __poc: {
    bridge: { getSnapshot(): string; dispatch(json: string): string };
    viewerCells: readonly [number, number, number, number] | null;
  };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function openApp(page: Page): Promise<void> {
  // Playwright intercepts file pickers only once a listener exists, and
  // turning that on is asynchronous: register it before anything can open one.
  page.on('filechooser', () => {});
  await page.goto('/');
  await expect(page.locator('#tui_ratzilla_grid pre').first()).toBeVisible();
  await expect.poll(() => status(page)).toContain('Ready');
  await expect.poll(() => viewerCells(page)).not.toBeNull();
}

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(
    () => JSON.parse((window as unknown as PocWindow).__poc.bridge.getSnapshot()) as Snapshot,
  );

const viewerCells = (page: Page) =>
  page.evaluate(() => (window as unknown as PocWindow).__poc.viewerCells);

/** The TUI's last line: the status. */
const status = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('#tui_ratzilla_grid pre');
    return rows[rows.length - 1]?.textContent?.trim() ?? '';
  });

/**
 * The terminal's text. The shell redraws on the animation frame after a
 * snapshot arrives, so assert on it with `expect.poll`, not once.
 */
const screen = (page: Page): Promise<string> =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tui_ratzilla_grid pre')]
      .map((r) => r.textContent ?? '')
      .join('\n'),
  );

/** The centre of the first terminal cell where `text` starts. */
async function textCell(page: Page, text: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((needle) => {
    const rows = [...document.querySelectorAll('#tui_ratzilla_grid pre')];
    for (const row of rows) {
      const cells = [...row.children];
      const line = cells.map((c) => c.textContent || ' ').join('');
      const at = line.indexOf(needle);
      if (at >= 0) {
        const r = cells[at]!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  }, text);
  expect(point, `"${text}" on screen`).not.toBeNull();
  return point!;
}

async function viewerBox(page: Page): Promise<Box> {
  const box = await page.locator('#viewer').boundingBox();
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

const annotationTools = async (page: Page) => (await snapshot(page)).annotations.map((a) => a.tool);

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('the viewer covers exactly the cells the shell reserved for it', async ({ page }) => {
  const check = async () => {
    const cells = await viewerCells(page);
    expect(cells).not.toBeNull();
    const [col, row, cols, rows] = cells!;
    const geometry = await page.evaluate(
      ([c, r, w, h]) => {
        const grid = [...document.querySelectorAll('#tui_ratzilla_grid pre')];
        const cell = (x: number, y: number) => grid[y]!.children[x]!;
        const first = cell(c, r).getBoundingClientRect();
        const last = cell(c + w - 1, r + h - 1).getBoundingClientRect();
        return {
          expected: { x: first.left, y: first.top, right: last.right, bottom: last.bottom },
          // The viewer block's border, just outside the reserved cells (away
          // from its titles: top-left and bottom-right).
          left: cell(c - 1, r).textContent,
          top: cell(c + w - 1, r - 1).textContent,
          right: cell(c + w, r).textContent,
          bottom: cell(c, r + h).textContent,
        };
      },
      [col, row, cols, rows] as const,
    );
    expect([geometry.left, geometry.right]).toEqual(['│', '│']);
    expect([geometry.top, geometry.bottom]).toEqual(['─', '─']);
    const v = await viewerBox(page);
    expect(v.x).toBeCloseTo(geometry.expected.x, 0);
    expect(v.y).toBeCloseTo(geometry.expected.y, 0);
    expect(v.x + v.width).toBeCloseTo(geometry.expected.right, 0);
    expect(v.y + v.height).toBeCloseTo(geometry.expected.bottom, 0);
  };
  await check();

  // After a resize the terminal refits to the window and the viewer follows.
  const before = await viewerCells(page);
  await page.setViewportSize({ width: 960, height: 640 });
  await expect.poll(() => viewerCells(page)).not.toEqual(before);
  await check();
  const fill = await page.evaluate(() => {
    const grid = document.getElementById('tui_ratzilla_grid')!.getBoundingClientRect();
    return { right: innerWidth - grid.right, bottom: innerHeight - grid.bottom };
  });
  // Within one cell of the window's edges: the terminal fills the page.
  expect(fill.right).toBeLessThan(10);
  expect(fill.bottom).toBeLessThan(20);
});

test('tool keys draw, and a context limit disables the tool', async ({ page }) => {
  await page.keyboard.press('1');
  await expect.poll(async () => (await snapshot(page)).activeTool).toBe('rectangle');
  await drag(page, [0.2, 0.2], [0.35, 0.4]);
  await drag(page, [0.5, 0.2], [0.65, 0.4]);
  await expect.poll(() => annotationTools(page)).toEqual(['rectangle', 'rectangle']);

  const s = await snapshot(page);
  expect(s.constraints['rectangle']).toEqual({ enabled: false, current: 2, max: 2 });
  await expect.poll(() => screen(page)).toContain('2/2');

  await page.keyboard.press('1');
  await expect.poll(() => status(page)).toBe('Rectangle is not available in this context');
  expect((await snapshot(page)).activeTool).not.toBe('rectangle');
});

test('clicking a tool row in the TUI selects that tool', async ({ page }) => {
  const line = await textCell(page, '3  Line');
  await page.mouse.click(line.x, line.y);
  await expect.poll(async () => (await snapshot(page)).activeTool).toBe('line');
  await drag(page, [0.2, 0.7], [0.6, 0.8]);
  await expect.poll(() => annotationTools(page)).toEqual(['line']);
});

test('keys reach the drawing tool first, then the shell', async ({ page }) => {
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  await expect.poll(async () => (await snapshot(page)).activeContextId).toBe('ctx-3');
  await page.keyboard.press('5');
  await expect.poll(async () => (await snapshot(page)).activeTool).toBe('polyline');

  const points: [number, number][] = [
    [0.3, 0.5],
    [0.4, 0.4],
    [0.5, 0.55],
  ];
  for (const p of points) await clickViewer(page, p);
  // Escape cancels the polyline in progress; the shell never sees it.
  await page.keyboard.press('Escape');
  expect(await snapshot(page)).toMatchObject({ activeTool: 'polyline', annotations: [] });

  for (const p of points) await clickViewer(page, p);
  await page.keyboard.press('Enter');
  await expect.poll(() => annotationTools(page)).toEqual(['polyline']);
  expect((await snapshot(page)).activeTool).toBe('polyline');

  // With nothing in progress, Escape is the shell's: back to navigation.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await snapshot(page)).activeTool).toBeNull();
});

test('the annotation list selects, and x deletes the selection', async ({ page }) => {
  await page.keyboard.press('3');
  await drag(page, [0.2, 0.3], [0.4, 0.3]);
  await drag(page, [0.2, 0.6], [0.4, 0.6]);
  await expect.poll(() => annotationTools(page)).toEqual(['line', 'line']);
  const [first, second] = (await snapshot(page)).annotations;

  await page.keyboard.press('Shift+Tab'); // tools → annotations
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await snapshot(page)).selectedAnnotationId).toBe(second!.id);
  await page.keyboard.press('x');
  await expect
    .poll(async () => (await snapshot(page)).annotations.map((a) => a.id))
    .toEqual([first!.id]);
});

test('u and U undo and redo committed changes', async ({ page }) => {
  await page.keyboard.press('3');
  await drag(page, [0.2, 0.3], [0.4, 0.3]);
  await drag(page, [0.2, 0.6], [0.4, 0.6]);
  await expect.poll(() => annotationTools(page)).toHaveLength(2);
  expect((await snapshot(page)).canUndo).toBe(true);

  await page.keyboard.press('u');
  await expect.poll(() => annotationTools(page)).toHaveLength(1);
  await page.keyboard.press('u');
  await expect.poll(() => annotationTools(page)).toHaveLength(0);
  expect(await snapshot(page)).toMatchObject({ canUndo: false, canRedo: true });
  await page.keyboard.press('u');
  await expect.poll(() => status(page)).toBe('Nothing to undo');

  await page.keyboard.press('U');
  await expect.poll(() => annotationTools(page)).toHaveLength(1);
  // A new change discards what was left to redo.
  await drag(page, [0.6, 0.3], [0.8, 0.3]);
  await expect.poll(() => annotationTools(page)).toHaveLength(2);
  expect((await snapshot(page)).canRedo).toBe(false);
});

test('export, then import, round-trips the annotations', async ({ page }, testInfo) => {
  await page.keyboard.press('3');
  await drag(page, [0.2, 0.3], [0.4, 0.3]);
  await expect.poll(() => annotationTools(page)).toEqual(['line']);

  // Capture what the export writes, as well as letting it download.
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob) {
        void blob
          .text()
          .then((t) => ((window as unknown as { __exported: string }).__exported = t));
      }
      return create(blob);
    };
  });
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('e')]);
  expect(download.suggestedFilename()).toBe('annotations.json');
  const exported = testInfo.outputPath('annotations.json');
  await download.saveAs(exported);
  const text = await page.waitForFunction(
    () => (window as unknown as { __exported?: string }).__exported,
  );
  const doc = JSON.parse(String(await text.jsonValue())) as { toolType: string }[];
  expect(doc.map((a) => a.toolType)).toEqual(['line']);

  await page.keyboard.press('u');
  await expect.poll(() => annotationTools(page)).toEqual([]);

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('o')]);
  await chooser.setFiles(exported);
  await expect.poll(() => annotationTools(page)).toEqual(['line']);
  await expect.poll(() => status(page)).toBe('Imported 1 annotation(s) from annotations.json');

  const [again] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('o')]);
  await again.setFiles(`${testInfo.project.testDir}/fixtures/invalid.json`);
  await expect.poll(() => status(page)).toMatch(/^Import failed: /);
  expect(await annotationTools(page)).toEqual(['line']);
});

test('g cycles grid layouts and the arrows move between cells', async ({ page }) => {
  await page.keyboard.press('g');
  await expect.poll(async () => (await snapshot(page)).grid).toEqual({ columns: 2, rows: 1 });
  // The new cell gets an image that was not on screen.
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await snapshot(page)).activeCell).toBe(1);
  expect((await snapshot(page)).activeImageId).toBe('portrait');
  await expect.poll(() => screen(page)).toContain('Portrait · cell 2/2 (2×1)');

  await page.keyboard.press('g');
  await expect.poll(async () => (await snapshot(page)).grid).toEqual({ columns: 2, rows: 2 });
  await expect(page.locator('#viewer .openseadragon-container')).toHaveCount(4);
  await page.keyboard.press('g');
  await expect.poll(async () => (await snapshot(page)).grid).toEqual({ columns: 1, rows: 1 });
});

test('the help screen hides the viewer until a key closes it', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.locator('#viewer')).toBeHidden();
  await expect.poll(() => screen(page)).toContain('any key closes');
  await page.keyboard.press('Escape');
  await expect(page.locator('#viewer')).toBeVisible();
});

test('the bridge rejects a malformed command and says why', async ({ page }) => {
  const reply = await page.evaluate(() =>
    (window as unknown as PocWindow).__poc.bridge.dispatch('{"t":"grid","columns":9,"rows":1}'),
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
  await expect.poll(() => status(page)).toContain('Ready');
  for (const key of ['Tab', 'ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'ArrowDown', 'Enter']) {
    await page.keyboard.press(key);
  }
  await expect.poll(async () => (await snapshot(page)).activeImageId).toBe('tiled');
  await page.waitForTimeout(500);
  expect(offOrigin).toEqual([]);
});
