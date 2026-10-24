/**
 * Keyframes as ordinary annotations vs a TrackDocument: drives
 * keyframes.html (src/keyframes-page.ts) in Chromium and returns its rows.
 */
export async function runKeyframeAnnotationsBench(browser, base, { reps = 5 } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/keyframes.html`);
    await page.waitForFunction(() => window.__keyframes?.ready === true, null, { timeout: 60000 });
    const r = await page.evaluate((n) => window.__keyframes.run(n), reps);
    return { ...r, errors };
  } finally {
    await page.close();
  }
}
