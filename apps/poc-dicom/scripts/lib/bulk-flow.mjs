/**
 * Loads bulk.html at increasing N and records mount-to-Fabric-objects time,
 * pan frame times and JS heap — the scaling curve of "DICOM bulk annotations
 * as ordinary osdlabel annotations".
 */
export async function runBulkFlow(browser, origin, sizes = [500, 2000, 8000], timeoutMs = 150000) {
  const out = [];
  for (const n of sizes) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${origin}/bulk.html?n=${n}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: timeoutMs });
      const r = await page.evaluate(() => window.__bulk.measure());
      out.push(r);
      if (!Number.isFinite(r.mountToObjectsMs)) break; // gave up: larger N will not finish either
    } catch (err) {
      out.push({ n, error: String(err?.message ?? err).slice(0, 200) });
      break;
    } finally {
      await ctx.close();
    }
  }
  return out;
}
