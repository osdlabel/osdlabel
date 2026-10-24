/**
 * H3 harness run: draw a box on frame 10 with the stock RectangleTool (real
 * mouse events through FabricOverlay), move it on frame 40 with Fabric's own
 * drag, then scrub and check each frame's object against the expected
 * linear interpolation, and that the frame shown is the frame asked for.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './rng.mjs';
import { quantile } from './summarize.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function drag(page, a, b, steps = 10) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

const lerp = (a, b, t) => a + (b - a) * t;

export async function runH3Harness(browser, base, { video = 'h264-720p-30-g30-bf' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/tracks.html?video=${video}`);
    await page.waitForFunction(
      () => window.__tracks?.ready === true || window.__tracksError !== undefined,
      null,
      {
        timeout: 60000,
      },
    );
    const err = await page.evaluate(() => window.__tracksError ?? null);
    if (err !== null) throw new Error(err);
    const scrub = (f) => page.evaluate((x) => window.__tracks.scrub(x), f);
    const toScreen = (p) => page.evaluate((x) => window.__tracks.imageToScreen(x), p);

    const r10 = await scrub(10);
    await page.evaluate(() => window.__tracks.setMode('rectangle'));
    await drag(page, await toScreen({ x: 200, y: 200 }), await toScreen({ x: 400, y: 350 }));
    const afterDraw = await page.evaluate(() => window.__tracks.document());
    const r40 = await scrub(40);
    await page.evaluate(() => window.__tracks.setMode('select'));
    await drag(page, await toScreen({ x: 300, y: 275 }), await toScreen({ x: 700, y: 375 }));
    await page.waitForTimeout(100);
    const doc = await page.evaluate(() => window.__tracks.document());
    const kfs = doc.tracks[0]?.keyframes ?? [];
    const k10 = kfs.find((k) => k.frame === 10)?.geometry;
    const k40 = kfs.find((k) => k.frame === 40)?.geometry;

    const sweep = [];
    for (let f = 10; f <= 40; f++) sweep.push(await scrub(f));
    for (let f = 39; f >= 10; f--) sweep.push(await scrub(f));
    const rnd = mulberry32(3);
    for (let k = 0; k < 20; k++) sweep.push(await scrub(Math.floor(rnd() * 300)));

    const r25 = await scrub(25);
    await page.screenshot({ path: path.join(APP_DIR, 'results', 'tracks-frame25.png') });

    let maxErrPx = 0;
    let wrongFrames = 0;
    for (const r of sweep) {
      if (r.shown !== r.frame) wrongFrames++;
      const g = r.objects[0]?.geometry;
      if (k10 === undefined || k40 === undefined || g === null || g === undefined) continue;
      let ex;
      if (r.frame <= 10) ex = r.frame < 10 ? null : k10;
      else if (r.frame >= 40) ex = k40;
      else {
        const t = (r.frame - 10) / 30;
        ex = {
          origin: {
            x: lerp(k10.origin.x, k40.origin.x, t),
            y: lerp(k10.origin.y, k40.origin.y, t),
          },
        };
      }
      if (ex !== null) {
        maxErrPx = Math.max(
          maxErrPx,
          Math.abs(g.origin.x - ex.origin.x),
          Math.abs(g.origin.y - ex.origin.y),
        );
      }
    }
    const stats = await page.evaluate(() => window.__tracks.stats());
    const g25 = r25.objects[0]?.geometry;
    const rows = [
      { check: 'frame shown on scrub(10)', value: r10.shown, pass: r10.shown === 10 },
      {
        check: 'draw on frame 10 -> track with keyframe [10]',
        value: JSON.stringify(afterDraw.tracks.map((t) => t.keyframes.map((k) => k.frame))),
        pass: afterDraw.tracks.length === 1 && afterDraw.tracks[0].keyframes.length === 1,
      },
      {
        check: 'frame 40 before move: held keyframe',
        value: r40.samples[0]?.source,
        pass: r40.samples[0]?.source === 'held',
      },
      {
        check: 'move on frame 40 -> keyframes',
        value: JSON.stringify(kfs.map((k) => k.frame)),
        pass: kfs.length === 2,
      },
      {
        check: 'frame 25 origin (expected midpoint)',
        value:
          g25 && k10 && k40
            ? `${g25.origin.x.toFixed(1)},${g25.origin.y.toFixed(1)} vs ${((k10.origin.x + k40.origin.x) / 2).toFixed(1)},${((k10.origin.y + k40.origin.y) / 2).toFixed(1)}`
            : 'n/a',
        pass: r25.samples[0]?.source === 'interpolated',
      },
      {
        check: 'max |object - lerp| over sweep (image px)',
        value: maxErrPx.toFixed(3),
        pass: maxErrPx < 0.01,
      },
      {
        check: 'scrubs showing the wrong frame',
        value: `${wrongFrames}/${sweep.length}`,
        pass: wrongFrames === 0,
      },
      {
        check: 'scrub latency p50 / p95 / max ms (decode + OSD draw + overlay)',
        value: `${quantile(
          sweep.map((r) => r.ms),
          0.5,
        ).toFixed(1)} / ${quantile(
          sweep.map((r) => r.ms),
          0.95,
        ).toFixed(1)} / ${Math.max(...sweep.map((r) => r.ms)).toFixed(1)}`,
        pass: true,
      },
    ];
    return { video, rows, keyframes: kfs, decoderStats: stats, errors, trackDocument: doc };
  } finally {
    await ctx.close();
  }
}
