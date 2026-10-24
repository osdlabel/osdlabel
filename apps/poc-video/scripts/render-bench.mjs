/**
 * H2: 1080p playback through each render host, static, under slow pan + zoom,
 * and under a fast pan (about 1,600 px/s), `reps` times each. The default
 * source is 60 fps, so a host that keeps up shows ~60 content fps and one
 * that cannot shows its own ceiling (a 30 fps source capped the first run's
 * metric at the target). Per cell: fps (rAF and content), dropped/late frames, JS time,
 * main-thread busy time (CDP Performance), CPU per process type (CDP
 * SystemInfo: renderer vs GPU process, where SwiftShader runs), and sync
 * error read from screenshots: the Fabric green square must abut the video's
 * red marker (spatial), and the Fabric 4x4 frame code must equal the video's
 * (temporal).
 */
import os from 'node:os';
import { PNG } from 'pngjs';

// [host, source, decorations]. Every cell carries 50 interpolated rectangles
// on the Fabric overlay; `deco` adds their label + area DOM decorations (100
// elements) recomputed per frame. Two of the fastest combos also run without
// them, to price the decorations alone (the first run did that A/B on a
// starved 5 fps WebGL cell, which could not show a 2-3 ms cost).
const COMBOS = [
  ['osd-canvas', 'video', true],
  ['osd-direct', 'video', true],
  ['osd-webgl', 'video', true],
  ['css', 'video', true],
  ['osd-canvas', 'webcodecs', true],
  ['osd-direct', 'webcodecs', true],
  ['osd-webgl', 'webcodecs', true],
  ['css', 'webcodecs', true],
  ['css', 'webcodecs', false],
  ['osd-direct', 'webcodecs', false],
];
const MOTIONS = ['static', 'panzoom', 'fastpan'];
const SHOTS = { static: 8, panzoom: 12, fastpan: 12 };

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
    // Speed over two rAFs right before the shot: an average across the
    // screenshot itself (hundreds of ms) under-reads an oscillating pan.
    const speed = await page.evaluate(() => window.__render.markerSpeed());
    const buf = await page.screenshot({ type: 'png' });
    out.push({ ...analyzeScreenshot(buf), markerSpeedPxPerS: speed });
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
  { seconds = 6, reps = 3, video = 'h264-1080p-60-g60-bf', combos = null, motions = null } = {},
) {
  const bcdp = await browser.newBrowserCDPSession();
  const rows = [];
  const raw = [];
  const list =
    combos === null
      ? COMBOS
      : COMBOS.filter(([h, s, d]) => combos.includes(`${h}/${s}${d ? '' : '/nodeco'}`));
  // Reps are the outer loop, so a load spike on the shared host hits one rep
  // of many cells rather than every rep of one cell.
  const cells = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const [host, source, deco] of list) {
      for (const motion of motions ?? MOTIONS) cells.push([rep, host, source, deco, motion]);
    }
  }
  for (const [rep, host, source, deco, motion] of cells) {
    {
      process.stderr.write(
        `H2 rep ${rep + 1}/${reps} ${host}/${source}${deco ? '' : '/nodeco'} ${motion} ...\n`,
      );
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
      });
      try {
        await page.goto(
          `${base}/render.html?host=${host}&source=${source}&video=${video}&deco=${deco ? 1 : 0}`,
        );
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
        const sync = await sampleSync(page, SHOTS[motion]);
        const cpu = Object.fromEntries(
          Object.keys(c1).map((k) => [k, (c1[k] - (c0[k] ?? 0)) / wall]),
        );
        const syncSummary = summarizeSync(sync);
        const row = {
          rep,
          host,
          source,
          deco: deco ? 'on' : 'off',
          motion,
          rafFps: r2(st.rafFps),
          contentFps: r2(st.contentFps),
          skipped: st.skippedFrames,
          late: st.lateFrames,
          dropped: st.droppedVideoFrames,
          handlerMs: r2(st.handlerMsPerFrame),
          osdDrawMs: r2(st.osdDrawMsPerDraw),
          fabricMs: r2(st.fabricMsPerRender),
          decoMs: r2(st.decoMsPerFrame),
          decoEls: st.decorationElements,
          clockLag: r2(st.meanClockLagFrames),
          mainBusyPct: r2((100 * (m1.TaskDuration - m0.TaskDuration)) / wall),
          cpuRenderer: r2(cpu.renderer ?? 0),
          cpuGpu: r2(cpu.GPU ?? cpu.gpu ?? 0),
          cpuBrowser: r2(cpu.browser ?? 0),
          syncMaxPx: syncSummary.spatialMaxPx,
          markerPxPerS: r2(syncSummary.meanMarkerSpeedPxPerS),
          frameDelta: JSON.stringify(syncSummary.frameDeltaHistogram),
          // Host 1-minute load average when the cell ended: other processes
          // on a shared machine show up here before they show up as noise.
          load1: r2(os.loadavg()[0]),
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
          rep,
          host,
          source,
          deco: deco ? 'on' : 'off',
          motion,
          error: String(e).slice(0, 200),
        });
        raw.push({ host, source, deco, motion, error: String(e), errors });
      } finally {
        await ctx.close();
      }
    }
  }
  return {
    video,
    seconds,
    reps,
    viewport: '1280x720',
    cells: aggregateH2(rows, raw),
    notes:
      'cpu* = CPU cores used (process cpuTime delta / wall). GPU process = SwiftShader software rasterisation in this sandbox. mainBusyPct = renderer main-thread TaskDuration / wall. fabricMs = per-frame overlay update (50 rect sets + frame code + sync) excluding decoMs; decoMs = label + area providers and DecorationLayer.setDecorations per frame. syncMaxPx = worst |offset| of the Fabric green square from the video red marker in screenshots; frameDelta = histogram of (overlay frame code - video frame code) in the same screenshots.',
    rows,
    raw,
  };
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)];
};

/**
 * One row per (host, source, deco, motion) over its reps: median / min / max
 * content fps, and frame lock pooled over every screenshot of every rep:
 * `behind` counts screenshots where the overlay's frame differs from the
 * video frame on screen (`frameDelta` != 0), `lockedPct` the rest.
 */
export function aggregateH2(rows, raw) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const k = `${r.host}/${r.source}/${r.deco}/${r.motion}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ row: r, raw: raw[i] });
  });
  const out = [];
  for (const [k, g] of groups) {
    const ok = g.filter((x) => x.row.error === undefined);
    const fps = ok.map((x) => x.row.contentFps);
    const hist = {};
    let shots = 0;
    let maxSpatial = 0;
    let speed = 0;
    for (const x of ok) {
      for (const [d, n] of Object.entries(x.raw.syncSummary.frameDeltaHistogram)) {
        hist[d] = (hist[d] ?? 0) + n;
        shots += n;
      }
      maxSpatial = Math.max(maxSpatial, x.raw.syncSummary.spatialMaxPx ?? 0);
      speed += x.raw.syncSummary.meanMarkerSpeedPxPerS ?? 0;
    }
    const [host, source, deco, motion] = k.split('/');
    out.push({
      host,
      source,
      deco,
      motion,
      reps: ok.length,
      errors: g.length - ok.length,
      contentFpsMedian: median(fps),
      contentFpsMin: fps.length ? Math.min(...fps) : null,
      contentFpsMax: fps.length ? Math.max(...fps) : null,
      rafFpsMedian: median(ok.map((x) => x.row.rafFps)),
      mainBusyPctMedian: median(ok.map((x) => x.row.mainBusyPct)),
      handlerMsMedian: median(ok.map((x) => x.row.handlerMs)),
      fabricMsMedian: median(ok.map((x) => x.row.fabricMs)),
      decoMsMedian: median(ok.map((x) => x.row.decoMs)),
      clockLagMedian: median(ok.map((x) => x.row.clockLag)),
      shotsRead: shots,
      behind: shots - (hist['0'] ?? 0),
      lockedPct: shots === 0 ? null : r2((100 * (hist['0'] ?? 0)) / shots),
      frameDelta: JSON.stringify(hist),
      syncMaxPx: maxSpatial,
      markerPxPerS: ok.length ? r2(speed / ok.length) : null,
      load1Median: median(ok.map((x) => x.row.load1)),
    });
  }
  return out;
}
