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
    // Pixels, not properties: paint only the rectangle through Fabric's own
    // render (object caching at its default) after each in-place update, at
    // two zooms, and compare the painted box with the geometry's box.
    const rectId = doc.tracks[0]?.id;
    const boxErrs = [];
    const boxes = [];
    let caching = null;
    for (const zoom of [1, 2.5]) {
      if (zoom !== 1) await page.evaluate((z) => window.__tracks.zoomBy(z), zoom);
      for (let f = 10; f <= 40; f += 3) {
        await scrub(f);
        const b = await page.evaluate((id) => window.__tracks.renderedBox(id), rectId);
        if (b !== null) {
          boxes.push({ zoom, frame: f, ...b });
          boxErrs.push(b.maxEdgeErrPx);
          caching = b.objectCaching;
        }
      }
      if (zoom !== 1) await page.evaluate((z) => window.__tracks.zoomBy(1 / z), zoom);
    }

    // Occlusion and leaving the frame, set the way an annotator would.
    await scrub(25);
    await page.evaluate((id) => window.__tracks.setVisibility(id, 'occluded'), rectId);
    const occ = [];
    for (const f of [25, 30, 39, 40]) occ.push(await scrub(f));
    const occOk =
      occ
        .slice(0, 3)
        .every((r) => r.samples[0]?.visibility === 'occluded' && r.objects[0]?.visible) &&
      occ[3].samples[0]?.visibility === 'visible';
    const occFaded = occ[1].objects[0]?.opacity < occ[3].objects[0]?.opacity;
    // Still interpolated while occluded: frame 30 is on the k10 -> k40 line.
    const g30 = occ[1].objects[0]?.geometry;
    const t30 = 20 / 30;
    const occErr =
      g30 && k10 && k40
        ? Math.max(
            Math.abs(g30.origin.x - lerp(k10.origin.x, k40.origin.x, t30)),
            Math.abs(g30.origin.y - lerp(k10.origin.y, k40.origin.y, t30)),
          )
        : Infinity;
    await scrub(60);
    await page.evaluate((id) => window.__tracks.setVisibility(id, 'outside'), rectId);
    const out59 = await scrub(59);
    const out60 = await scrub(60);
    const out200 = await scrub(200);
    const outsideOk =
      out59.objects[0]?.visible === true &&
      out60.objects[0]?.visible === false &&
      out200.objects[0]?.visible === false;

    // Polygon 12 CCW -> 24 CW with an outside gap, and a held brush mask.
    const [polyId, maskId] = await page.evaluate(() => window.__tracks.addDemoTracks());
    const pick = (r, id) => ({
      obj: r.objects.find((o) => o.id === id),
      smp: r.samples.find((o) => o.id === id),
    });
    const demo = {};
    for (const f of [99, 100, 105, 115, 116, 125, 130, 135, 140, 150, 159, 160, 200]) {
      demo[f] = await scrub(f);
    }
    const area = (pts) => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        s += a.x * b.y - b.x * a.y;
      }
      return Math.abs(s / 2);
    };
    const polyPts = (f) => pick(demo[f], polyId).obj?.geometry?.points ?? [];
    const a100 = area(polyPts(100));
    const a130 = area(polyPts(130));
    const a115 = area(polyPts(115));
    const polyVisible = (f) => pick(demo[f], polyId).obj?.visible === true;
    const maskFrom = (f) => pick(demo[f], maskId).smp?.payloadFrame ?? null;
    const maskVisible = (f) => pick(demo[f], maskId).obj?.visible === true;
    await scrub(115);
    await page.screenshot({ path: path.join(APP_DIR, 'results', 'tracks-frame115.png') });
    const counters = await page.evaluate(() => window.__tracks.counters());

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
      {
        check:
          'painted pixels vs the object box after in-place updates, max edge err px (22 frames, zoom 1 and 2.5)',
        value: `${Math.max(...boxErrs).toFixed(2)} (objectCaching=${caching})`,
        pass: boxErrs.length === 22 && Math.max(...boxErrs) <= 3,
      },
      {
        // Not a temporal-model check: how far the stock rectangle builder's
        // object sits from its geometry (Fabric 7 defaults origin to center).
        check: 'stock Rect object box vs its geometry box, px (origin = top-left expected)',
        value: `${Math.max(...boxes.map((b) => b.geometryOffsetPx)).toFixed(2)} max, ${Math.min(...boxes.map((b) => b.geometryOffsetPx)).toFixed(2)} min (originX=${boxes[0]?.originX})`,
        pass: Math.max(...boxes.map((b) => b.geometryOffsetPx)) <= 1,
      },
      {
        check: 'occluded from frame 25: frames 25-39 occluded + faded, 40 visible',
        value: `${occ.map((r) => `${r.frame}:${r.samples[0]?.visibility}@${(r.objects[0]?.opacity ?? 0).toFixed(2)}`).join(' ')}`,
        pass: occOk && occFaded,
      },
      {
        check: 'occluded track still interpolates (frame 30 vs lerp, px)',
        value: occErr.toFixed(3),
        pass: occErr < 0.01,
      },
      {
        check: 'outside from frame 60: 59 shown, 60 and 200 hidden',
        value: `${out59.objects[0]?.visible}/${out60.objects[0]?.visible}/${out200.objects[0]?.visible}`,
        pass: outsideOk,
      },
      {
        check: 'polygon vertex counts at 100 / 115 / 130 (12 CCW -> 24 CW)',
        value: `${polyPts(100).length} / ${polyPts(115).length} / ${polyPts(130).length}`,
        pass: polyPts(100).length === 12 && polyPts(130).length === 24 && polyPts(115).length >= 24,
      },
      {
        check: 'polygon area at 115 / mean(area 100, area 130)',
        value: (a115 / ((a100 + a130) / 2)).toFixed(3),
        pass: Math.abs(a115 / ((a100 + a130) / 2) - 1) < 0.2,
      },
      {
        check: 'polygon gap: shown 99/100/135/159/160 (hidden 99, 140-159)',
        value: [99, 100, 135, 140, 150, 159, 160]
          .map((f) => `${f}:${polyVisible(f) ? 'on' : 'off'}`)
          .join(' '),
        pass:
          !polyVisible(99) &&
          polyVisible(100) &&
          polyVisible(135) &&
          !polyVisible(140) &&
          !polyVisible(150) &&
          !polyVisible(159) &&
          polyVisible(160),
      },
      {
        check: 'mask held at nearest keyframe: pixels from frame (100,105,115,116,125,130,200)',
        value: [100, 105, 115, 116, 125, 130, 200].map((f) => `${f}<-${maskFrom(f)}`).join(' '),
        pass:
          maskFrom(100) === 100 &&
          maskFrom(105) === 100 &&
          maskFrom(115) === 100 &&
          maskFrom(116) === 130 &&
          maskFrom(125) === 130 &&
          maskFrom(130) === 130 &&
          maskFrom(200) === 130 &&
          !maskVisible(99) &&
          maskVisible(116),
      },
      {
        check:
          'Fabric object updates: in place / rebuilt / unchanged; contour correspondences computed',
        value: `${counters.inPlace} / ${counters.rebuilt} / ${counters.unchanged}; ${counters.correspondences}`,
        pass: true,
      },
    ];
    return {
      video,
      rows,
      keyframes: kfs,
      paintedBoxes: boxes,
      decoderStats: stats,
      errors,
      trackDocument: doc,
    };
  } finally {
    await ctx.close();
  }
}
