import { test, expect } from '@playwright/test';

/**
 * Overlay-alignment guard for container resizes — the code path a fullscreen
 * transition takes.
 *
 * Annotations are painted through the Fabric canvas's `viewportTransform`; the
 * image is painted by OSD. They agree only if that matrix tracks OSD's
 * viewport state. This probe samples every animation frame across a sequence
 * of resizes and records the worst disagreement in screen pixels, so a
 * regression surfaces as a number rather than as something a human has to
 * notice flickering.
 *
 * What it does NOT do: discriminate the pre-`after-resize` paint ordering.
 * Verified by reverting that change — this still passes, because OSD's rAF
 * loop runs before this probe's callback within a frame, so any superseded
 * paint is overwritten before the browser composites. See BACKLOG.md BL-001.
 */
const PROBE_TOLERANCE_PX = 0.5;

interface ProbeResult {
  readonly frames: number;
  readonly maxDiff: number;
}

declare global {
  interface Window {
    __resizeProbe?: { frames: number; maxDiff: number; stop: () => void };
  }
}

const startProbe = (page: import('@playwright/test').Page): Promise<void> =>
  page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdOverlay?: {
            canvas?: { viewportTransform: readonly number[] };
            imageToScreen?: (p: { x: number; y: number }) => { x: number; y: number };
          };
        })
      | null;

    const overlay = el?.__osdOverlay;
    const canvas = overlay?.canvas;
    if (!overlay?.imageToScreen || !canvas) throw new Error('test hooks not installed');
    const imageToScreen = overlay.imageToScreen.bind(overlay);

    const state = { frames: 0, maxDiff: 0, stop: () => {} };
    let running = true;
    state.stop = () => {
      running = false;
    };

    // Corners and centre of the 800x600 sample image. Off-origin points make
    // scale errors visible, not just translation errors.
    const probePoints = [
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { x: 0, y: 600 },
      { x: 800, y: 600 },
      { x: 400, y: 300 },
    ];

    const sample = (): void => {
      if (!running) return;
      const [a, b, c, d, tx, ty] = canvas.viewportTransform as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];

      let worst = 0;
      for (const point of probePoints) {
        // Where Fabric is actually painting this image pixel, per the matrix
        // it is rendering with...
        const painted = { x: a * point.x + c * point.y + tx, y: b * point.x + d * point.y + ty };
        // ...versus where OSD says that image pixel currently is. Independent
        // code paths: a 3-sample affine matrix vs. a direct per-point
        // conversion, so agreement is a real check rather than a tautology.
        const expected = imageToScreen(point);
        worst = Math.max(worst, Math.abs(painted.x - expected.x), Math.abs(painted.y - expected.y));
      }

      state.frames += 1;
      state.maxDiff = Math.max(state.maxDiff, worst);
      requestAnimationFrame(sample);
    };

    window.__resizeProbe = state;
    requestAnimationFrame(sample);
  });

/**
 * Samples the probe must take *after* each resize before the next one starts.
 *
 * The liveness check used to be a single `frames > 20` at the end, which made
 * the test a measurement of the host's frame rate rather than of alignment:
 * headless Chromium delivers well under 60fps, and with a DZI in the viewer
 * tile decode starves the rAF loop further — 3 of 8 repeats under two workers
 * landed on 19 samples.
 */
const SAMPLES_PER_RESIZE = 3;

/** Long enough to absorb a stall, short enough to fire before the test timeout. */
const SAMPLE_WAIT_MS = 10_000;

const framesSoFar = (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => window.__resizeProbe?.frames ?? 0);

/**
 * Resolve once the probe has taken `count` *further* samples beyond `from`.
 *
 * The delta matters. A cumulative threshold (wait for 3, then 6, then 9…)
 * against a counter that has been running since `startProbe` is satisfied in
 * advance by the samples taken during earlier steps — at 40fps the first
 * 250 ms alone covers the whole budget — so every later wait returns
 * instantly and the loop degrades to the bare timeout it replaced. Measuring
 * from a snapshot taken immediately before each resize is what actually
 * guarantees samples land after that resize.
 *
 * On a stall this rejects here rather than at an assertion after the loop, so
 * the failure names the resize that stalled. Its own timeout is shorter than
 * Playwright's test timeout so that it, not the generic timeout, is what fires.
 */
const awaitSamples = (
  page: import('@playwright/test').Page,
  from: number,
  count: number,
): Promise<unknown> =>
  page.waitForFunction((n) => (window.__resizeProbe?.frames ?? 0) >= n, from + count, {
    timeout: SAMPLE_WAIT_MS,
  });

const readProbe = (page: import('@playwright/test').Page): Promise<ProbeResult> =>
  page.evaluate(() => {
    const probe = window.__resizeProbe;
    if (!probe) throw new Error('probe not started');
    probe.stop();
    return { frames: probe.frames, maxDiff: probe.maxDiff };
  });

test.describe('Overlay alignment during resize', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.openseadragon-canvas');
    await page.getByTestId('filmstrip-item-tiled').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.openseadragon-canvas') as
        | (Element & { __osdViewer?: { isOpen?: () => boolean } })
        | null;
      return el?.__osdViewer?.isOpen?.() === true;
    });
  });

  test('the overlay transform never lags OSD across a resize sequence', async ({ page }) => {
    await startProbe(page);

    // Alternating axes and directions, so both the fitBounds path and the
    // resizeRatio === 1 degenerate case are exercised.
    const sizes = [
      { width: 1200, height: 800 },
      { width: 900, height: 800 },
      { width: 900, height: 600 },
      { width: 1400, height: 600 },
      { width: 1400, height: 900 },
      { width: 1000, height: 700 },
      { width: 1280, height: 720 },
    ];
    for (const size of sizes) {
      const before = await framesSoFar(page);
      await page.setViewportSize(size);
      // Let OSD's ResizeObserver fire and its update loop run the resize...
      await page.waitForTimeout(250);
      // ...and don't move on until the probe has sampled *this* resize.
      await awaitSamples(page, before, SAMPLES_PER_RESIZE);
    }

    const probe = await readProbe(page);

    // The premise — that the probe actually ran — is guarded by the waits
    // above, which reject at the resize that stalled. Asserting a frame floor
    // here as well would be dead weight: the loop cannot reach this line
    // without having cleared it.
    expect(probe.maxDiff).toBeLessThan(PROBE_TOLERANCE_PX);
  });
});
