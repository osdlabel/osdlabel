/**
 * H2: 1080p playback through each render host, with and without continuous
 * pan + zoom. Per cell: fps (rAF and content), dropped/late frames, JS time,
 * main-thread busy time (CDP Performance), CPU per process type (CDP
 * SystemInfo: renderer vs GPU process, where SwiftShader runs), and sync
 * error read from screenshots: the Fabric green square must abut the video's
 * red marker (spatial), and the Fabric 4x4 frame code must equal the video's
 * (temporal).
 */
import { PNG } from 'pngjs';

const COMBOS = [
  ['osd-canvas', 'video'],
  ['osd-webgl', 'video'],
  ['css', 'video'],
  ['osd-canvas', 'webcodecs'],
  ['osd-webgl', 'webcodecs'],
  ['css', 'webcodecs'],
];

async function processCpu(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const byType = {};
  for (const p of processInfo) byType[p.type] = (byType[p.type] ?? 0) + p.cpuTime;
  return byType;
}

async function perfMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

function bbox(png, pred) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  const { width, height, data } = png;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (pred(data[o], data[o + 1], data[o + 2])) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return n === 0 ? null : { x0, y0, x1, y1, n };
}

function lumaAt(png, cx, cy, r = 2) {
  let s = 0;
  let n = 0;
  for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y++) {
    for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) return NaN;
      const o = (y * png.width + x) * 4;
      s += 0.299 * png.data[o] + 0.587 * png.data[o + 1] + 0.114 * png.data[o + 2];
      n++;
    }
  }
  return s / n;
}

function readCode(png, left, top, cellPx) {
  let v = 0;
  for (let k = 0; k < 16; k++) {
    const l = lumaAt(
      png,
      left + ((k % 4) + 0.5) * cellPx,
      top + (Math.floor(k / 4) + 0.5) * cellPx,
    );
    if (!Number.isFinite(l) || (l > 70 && l < 185)) return -1;
    v = (v << 1) | (l >= 128 ? 1 : 0);
  }
  return v;
}

export function analyzeScreenshot(buf) {
  const png = PNG.sync.read(buf);
  const red = bbox(png, (r, g, b) => r > 190 && g < 70 && b < 70);
  const green = bbox(png, (r, g, b) => g > 190 && r < 70 && b < 70);
  if (red === null || green === null)
    return { ok: false, reason: red === null ? 'no red' : 'no green' };
  const sizePx = red.x1 - red.x0 + 1;
  const cellPx = sizePx / 4;
  const videoCode = readCode(png, red.x0, red.y1 + 1, cellPx);
  const overlayCode = readCode(png, green.x0, green.y1 + 1, cellPx);
  return {
    ok: true,
    // Image-space adjacency: green.left == red.right + 1, same top edge.
    dxPx: green.x0 - (red.x1 + 1),
    dyPx: green.y0 - red.y0,
    markerPx: sizePx,
    videoCode,
    overlayCode,
    frameDelta: videoCode >= 0 && overlayCode >= 0 ? overlayCode - videoCode : null,
  };
}

async function sampleSync(page, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = await page.evaluate(() => window.__render.markerScreen());
    const t0 = Date.now();
    const buf = await page.screenshot({ type: 'png' });
    const b = await page.evaluate(() => window.__render.markerScreen());
    const dt = (Date.now() - t0) / 1000;
    out.push({
      ...analyzeScreenshot(buf),
      markerSpeedPxPerS: Math.hypot(b.x - a.x, b.y - a.y) / dt,
    });
    await page.waitForTimeout(150);
  }
  return out;
}

function summarizeSync(samples) {
  const ok = samples.filter((s) => s.ok);
  const spatial = ok.map((s) => Math.max(Math.abs(s.dxPx), Math.abs(s.dyPx)));
  const deltas = ok.filter((s) => s.frameDelta !== null).map((s) => s.frameDelta);
  return {
    samples: samples.length,
    readable: ok.length,
    spatialMaxPx: spatial.length ? Math.max(...spatial) : null,
    spatialMeanPx: spatial.length ? spatial.reduce((a, b) => a + b, 0) / spatial.length : null,
    codesRead: deltas.length,
    frameDeltaHistogram: deltas.reduce((h, d) => ((h[d] = (h[d] ?? 0) + 1), h), {}),
    meanMarkerSpeedPxPerS: ok.length
      ? ok.reduce((a, s) => a + s.markerSpeedPxPerS, 0) / ok.length
      : null,
  };
}

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

export async function runH2(
  browser,
  base,
  { seconds = 6, video = 'h264-1080p-30-g30-bf', combos = null } = {},
) {
  const bcdp = await browser.newBrowserCDPSession();
  const rows = [];
  const raw = [];
  const list = combos === null ? COMBOS : COMBOS.filter(([h, s]) => combos.includes(`${h}/${s}`));
  for (const [host, source] of list) {
    for (const motion of [false, true]) {
      process.stderr.write(`H2 ${host}/${source} ${motion ? 'panzoom' : 'static'} ...\n`);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
      });
      try {
        await page.goto(`${base}/render.html?host=${host}&source=${source}&video=${video}`);
        await page.waitForFunction(
          () => window.__render?.ready === true || window.__renderError !== undefined,
          null,
          {
            timeout: 60000,
          },
        );
        const err = await page.evaluate(() => window.__renderError ?? null);
        if (err !== null) throw new Error(err);
        await page.evaluate(() => window.__render.play());
        await page.evaluate((m) => window.__render.setMotion(m), motion);
        await page.waitForTimeout(1500);
        const pcdp = await ctx.newCDPSession(page);
        await pcdp.send('Performance.enable');
        const m0 = await perfMetrics(pcdp);
        const c0 = await processCpu(bcdp);
        await page.evaluate(() => window.__render.resetStats());
        const w0 = Date.now();
        await page.waitForTimeout(seconds * 1000);
        const st = await page.evaluate(() => window.__render.stats());
        const wall = (Date.now() - w0) / 1000;
        const m1 = await perfMetrics(pcdp);
        const c1 = await processCpu(bcdp);
        const sync = await sampleSync(page, motion ? 12 : 6);
        const cpu = Object.fromEntries(
          Object.keys(c1).map((k) => [k, (c1[k] - (c0[k] ?? 0)) / wall]),
        );
        const syncSummary = summarizeSync(sync);
        const row = {
          host,
          source,
          motion: motion ? 'panzoom' : 'static',
          rafFps: r2(st.rafFps),
          contentFps: r2(st.contentFps),
          skipped: st.skippedFrames,
          late: st.lateFrames,
          dropped: st.droppedVideoFrames,
          handlerMs: r2(st.handlerMsPerFrame),
          osdDrawMs: r2(st.osdDrawMsPerDraw),
          fabricMs: r2(st.fabricMsPerRender),
          mainBusyPct: r2((100 * (m1.TaskDuration - m0.TaskDuration)) / wall),
          cpuRenderer: r2(cpu.renderer ?? 0),
          cpuGpu: r2(cpu.GPU ?? cpu.gpu ?? 0),
          cpuBrowser: r2(cpu.browser ?? 0),
          syncMaxPx: syncSummary.spatialMaxPx,
          frameDelta: JSON.stringify(syncSummary.frameDeltaHistogram),
        };
        rows.push(row);
        raw.push({
          ...row,
          stats: st,
          cpuCoresByProcessType: cpu,
          sync,
          syncSummary,
          errors: errors.slice(0, 10),
        });
      } catch (e) {
        rows.push({
          host,
          source,
          motion: motion ? 'panzoom' : 'static',
          error: String(e).slice(0, 200),
        });
        raw.push({ host, source, motion, error: String(e), errors });
      } finally {
        await ctx.close();
      }
    }
  }
  return {
    video,
    seconds,
    viewport: '1280x720',
    notes:
      'cpu* = CPU cores used (process cpuTime delta / wall). GPU process = SwiftShader software rasterisation in this sandbox. mainBusyPct = renderer main-thread TaskDuration / wall.',
    rows,
    raw,
  };
}
