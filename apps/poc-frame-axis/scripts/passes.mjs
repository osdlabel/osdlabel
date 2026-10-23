/* global window -- page.evaluate callbacks run in the browser */
/**
 * Diagnostic: scroll the Solid harness three times over the same frames and
 * report fps / slices shown / canvas object counts per pass (first visits,
 * then revisits).
 *
 *   node scripts/passes.mjs '{"drawer":"canvas","annotationsPerFrame":10,"objectCaching":false}'
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extra = JSON.parse(process.argv[2] ?? '{}');
const port = Number(process.argv[3] ?? 5534);
const server = await createServer({
  configFile: path.join(APP, 'vite.config.mjs'),
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({
  headless: true,
  ...(exe ? { executablePath: exe } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await (
    await browser.newContext({ viewport: { width: 900, height: 900 } })
  ).newPage();
  await page.goto(`http://127.0.0.1:${port}/solid.html`);
  await page.waitForFunction('window.__poc && window.__poc.ready');
  await page.evaluate((o) => window.__poc.setup(o), {
    drawer: 'canvas',
    frames: 300,
    width: 512,
    height: 512,
    annotationsPerFrame: 10,
    ...extra,
  });
  console.log('setup', await page.evaluate(() => window.__poc.objectCount()));
  for (const label of ['pass1', 'pass2', 'pass3']) {
    const r = await page.evaluate(() => window.__poc.scroll({ rate: 60, durationMs: 2000 }));
    const c = await page.evaluate(() => window.__poc.objectCount());
    console.log(label, {
      fps: r.displayFps,
      shown: r.shownSlicesPerSec,
      incoherent: r.incoherentFrames,
      heap: r.jsHeapMB,
      ...c,
    });
  }
} finally {
  await browser.close();
  await server.close();
}
