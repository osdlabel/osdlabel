/**
 * H4 drivers: the WebGL context budget of a grid of cells.
 *
 * Every configuration runs in a fresh browser context (its own renderer
 * process), so context counts never leak between configurations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = fs.readFileSync(path.join(HERE, '..', 'src', 'probe', 'context-probe.js'), 'utf8');

async function gridPage(browser, base) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript({ content: PROBE });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || /WebGL|context/i.test(t))
      consoleErrors.push(`${m.type()}: ${t.slice(0, 200)}`);
  });
  await page.goto(`${base}/grid.html`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, {
    timeout: 60000,
  });
  return { context, page, consoleErrors };
}

async function screenshotCells(page) {
  const png = await page.screenshot();
  return page.evaluate((b64) => window.__grid.analyzeScreenshot(b64), png.toString('base64'));
}

/** Build N cells, redraw them all, count contexts and blank cells; optionally pan. */
async function measure(browser, base, n, mode, { pan = false, panMs = 2000 } = {}) {
  const { context, page, consoleErrors } = await gridPage(browser, base);
  try {
    const built = await page.evaluate(({ n, mode }) => window.__grid.build(n, mode), { n, mode });
    await page.evaluate(() => window.__grid.redrawAll());
    const cellsSeen = await screenshotCells(page);
    const contexts = await page.evaluate(() => window.__grid.probeSummary());
    const row = {
      n,
      mode,
      buildMs: built.buildMs,
      drawerTypes: built.drawerTypes,
      contexts,
      blankCells: cellsSeen.filter((c) => !c.imageVisible).length,
      blankIndices: cellsSeen.filter((c) => !c.imageVisible).map((c) => c.index),
      annotationHidden: cellsSeen.filter((c) => c.redPixels === 0).length,
      webglWarnings: consoleErrors.filter((e) => /WebGL|context/i.test(e)).slice(0, 3),
    };
    if (pan) row.pan = await page.evaluate((ms) => window.__grid.panAll(ms), panMs);
    if (mode.startsWith('voi')) {
      const ts = await page.evaluate(() => window.__grid.voiTargetStats());
      row.copyMsTotal = ts.reduce((a, s) => Math.max(a, s.copyMs ?? 0), 0);
    }
    return row;
  } finally {
    await context.close();
  }
}

/** Run a section, recording its error instead of losing the whole group. */
async function section(out, key, log, fn) {
  try {
    await fn();
  } catch (e) {
    log(`  ${key} failed: ${e.message.split('\n')[0]}`);
    out.errors = out.errors ?? {};
    out.errors[key] = e.message.split('\n').slice(0, 3).join(' ');
  }
}

export async function runGridExperiments({ browser, base, quick, log, out }) {
  Object.assign(out, { sweeps: {}, recovery: {}, foreign: {}, swap: null, records: {} });
  const fullSweep = quick ? [1, 8, 15, 16, 17, 20] : Array.from({ length: 24 }, (_, i) => i + 1);
  const panAt = new Set([1, 4, 9, 16, 24]);
  const modes = ['stock-default', 'stock-canvas', 'voi-own', 'voi-shared', 'voi-page'];
  for (const mode of modes) {
    const ns =
      mode === 'stock-default' ? fullSweep : quick ? [1, 16, 17] : [1, 4, 9, 16, 17, 20, 24];
    out.sweeps[mode] = [];
    for (const n of ns) {
      log(`H4 ${mode} N=${n}`);
      await section(out, `${mode}-${n}`, log, async () => {
        out.sweeps[mode].push(
          await measure(browser, base, n, mode, {
            pan: panAt.has(n) || (quick && n === 16),
            panMs: quick ? 1000 : 2000,
          }),
        );
      });
    }
  }

  // Where do one cell's contexts come from? (stack of each getContext)
  await section(out, 'records', log, async () => {
    const { context, page } = await gridPage(browser, base);
    await page.evaluate(() => window.__grid.build(1, 'stock-default'));
    out.records.oneStockCell = await page.evaluate(() => window.__grid.probeRecords());
    await context.close();
  });

  // Recovery: 17 cells evict cell 0; free 16 contexts; does cell 0 come back?
  for (const mode of ['stock-default', 'voi-own']) {
    log(`H4 recovery ${mode}`);
    await section(out, `recovery-${mode}`, log, async () => {
      const { context, page } = await gridPage(browser, base);
      await page.evaluate((mode) => window.__grid.build(17, mode), mode);
      await page.evaluate(() => window.__grid.redrawAll());
      const before = await screenshotCells(page);
      const cell0Liveness = await page.evaluate(() => window.__grid.liveness(0));
      const cell16Liveness = await page.evaluate(() => window.__grid.liveness(16));
      const afterDestroy = await page.evaluate(() => window.__grid.destroyRange(1, 17));
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.__grid.redrawAll());
      const after = await screenshotCells(page);
      out.recovery[mode] = {
        cell0VisibleWith17: before[0].imageVisible,
        cell0UpdateViewportEventsDuringPan: cell0Liveness.updates,
        healthyCellUpdateViewportEventsDuringPan: cell16Liveness.updates,
        contextsAfterFreeing16: afterDestroy,
        cell0VisibleAfterFreeing: after[0].imageVisible,
        contextsFinal: await page.evaluate(() => window.__grid.probeSummary()),
      };
      await context.close();
    });
  }

  // A competing WebGL user next to a full 4x4 grid.
  for (const mode of ['stock-default', 'voi-shared', 'stock-canvas']) {
    log(`H4 foreign context with 16 ${mode} cells`);
    await section(out, `foreign-${mode}`, log, async () => {
      const { context, page } = await gridPage(browser, base);
      await page.evaluate((mode) => window.__grid.build(16, mode), mode);
      await page.evaluate(() => window.__grid.redrawAll());
      const before = await screenshotCells(page);
      await page.evaluate(() => window.__grid.addForeign());
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__grid.redrawAll());
      const after = await screenshotCells(page);
      out.foreign[mode] = {
        blankBefore: before.filter((c) => !c.imageVisible).length,
        blankAfter: after.filter((c) => !c.imageVisible).length,
        blankIndicesAfter: after.filter((c) => !c.imageVisible).map((c) => c.index),
        contexts: await page.evaluate(() => window.__grid.probeSummary()),
      };
      await context.close();
    });
  }

  // Mitigation (i): swap non-active cells to the CanvasDrawer at runtime.
  out.swap = {};
  for (const via of ['raw', 'overlay']) {
    await section(out, `swap-${via}`, log, async () => {
      log(`H4 runtime drawer swap via ${via} (cells 1-15 of 16 to canvas)`);
      const { context, page } = await gridPage(browser, base);
      await page.evaluate(() => window.__grid.build(16, 'stock-default'));
      const swap = await page.evaluate((via) => window.__grid.swapDrawers('canvas', 1, via), via);
      await page.evaluate(() => window.__grid.redrawAll());
      const seen = await screenshotCells(page);
      out.swap[via] = {
        ...swap,
        annotationHiddenAfterSwap: seen.filter((c) => c.redPixels === 0).map((c) => c.index),
        blankAfterSwap: seen.filter((c) => !c.imageVisible).map((c) => c.index),
        panAfterSwap: await page.evaluate((ms) => window.__grid.panAll(ms), quick ? 1000 : 2000),
      };
      // And back: the cells return to WebGL (e.g. on activation).
      const back = await page.evaluate(() => window.__grid.swapDrawers('webgl', 1, 'overlay'));
      out.swap[via].backToWebgl = { swapMs: back.swapMs, contexts: back.contexts };
      await context.close();
    });
  }
  return out;
}

/**
 * The stock osdlabel Solid dev app at its maximum 4x4 grid: count contexts
 * per cell and see what one extra WebGL context does.
 */
export async function runDevAppExperiment({ browser, repoRoot, port, log }) {
  const devRoot = path.join(repoRoot, 'apps', 'dev');
  const server = await createServer({
    configFile: path.join(devRoot, 'vite.config.ts'),
    root: devRoot,
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript({ content: PROBE });
  const page = await context.newPage();
  try {
    log('dev app: open, 4x4 grid, assign 16 images');
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 60000 });
    await page.waitForTimeout(1500);
    const oneCell = await page.evaluate(() => window.__ctxProbe.summary());
    await page.getByTestId('grid-selector-trigger').click();
    await page.getByTestId('grid-cell-4-4').click();
    await page.waitForTimeout(500);
    const items = await page.locator('[data-testid^="filmstrip-item-"]').all();
    let assigned = 1;
    for (let k = 0; k < 15; k++) {
      const placeholder = page.locator('text=Assign an image').first();
      if ((await placeholder.count()) === 0) break;
      await placeholder.click();
      await items[(k + 1) % items.length].click();
      assigned++;
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(2500);
    const sixteen = await page.evaluate(() => window.__ctxProbe.summary());
    const cellBoxes = await page.evaluate(() =>
      [...document.querySelectorAll('.openseadragon-container')].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }),
    );
    const visible = async () => {
      // Hover-scroll every cell a notch so each redraws, then inspect.
      for (const b of cellBoxes) {
        await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
        await page.mouse.wheel(0, -40);
      }
      await page.waitForTimeout(800);
      const png = await page.screenshot();
      return page.evaluate(
        async ({ b64, boxes }) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const oc = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = oc.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
          return boxes.map((r) => {
            let s = 0;
            let s2 = 0;
            let n = 0;
            for (let y = Math.round(r.y) + 4; y < r.y + r.h - 4; y += 3) {
              for (let x = Math.round(r.x) + 4; x < r.x + r.w - 4; x += 3) {
                const o = (y * bmp.width + x) * 4;
                const l = (px[o] + px[o + 1] + px[o + 2]) / 3;
                s += l;
                s2 += l * l;
                n++;
              }
            }
            const m = s / n;
            return Math.sqrt(Math.max(0, s2 / n - m * m)) > 8;
          });
        },
        { b64: png.toString('base64'), boxes: cellBoxes },
      );
    };
    const visibleBefore = await visible();
    log('dev app: add one foreign WebGL context');
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      document.body.appendChild(c);
      const gl = c.getContext('webgl2');
      gl.clearColor(1, 0, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    await page.waitForTimeout(500);
    const visibleAfter = await visible();
    return {
      cellsAssigned: assigned,
      osdContainers: cellBoxes.length,
      contextsWithOneCell: oneCell,
      contextsWith16Cells: sixteen,
      contextsAfterForeign: await page.evaluate(() => window.__ctxProbe.summary()),
      visibleCellsBefore: visibleBefore.filter(Boolean).length,
      visibleCellsAfterForeign: visibleAfter.filter(Boolean).length,
      blankIndicesAfterForeign: visibleAfter.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0),
    };
  } finally {
    await context.close();
    await server.close();
  }
}
