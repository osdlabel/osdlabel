/**
 * Eyeball one render cell: serve, open render.html with the given query,
 * play with pan/zoom for 2 s, save a screenshot and print its sync analysis.
 *
 *   node scripts/shot.mjs "host=osd-webgl&source=video" out.png [--static]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { analyzeScreenshot } from './render-bench.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const query = process.argv[2] ?? 'host=osd-canvas&source=video';
const out = process.argv[3] ?? path.join(APP, 'results', 'shot.png');
const server = await createServer({
  configFile: path.join(APP, 'vite.config.mjs'),
  server: { port: 5431, strictPort: true, host: 'localhost' },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.BENCH_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  await page.goto(`http://localhost:5431/render.html?${query}`);
  await page.waitForFunction(
    () => window.__render?.ready === true || window.__renderError !== undefined,
    null,
    {
      timeout: 60000,
    },
  );
  console.log(await page.evaluate(() => window.__renderError ?? 'ready'));
  await page.evaluate(() => window.__render.play());
  await page.evaluate((m) => window.__render.setMotion(m), !process.argv.includes('--static'));
  await page.waitForTimeout(2000);
  const buf = await page.screenshot();
  fs.writeFileSync(out, buf);
  console.log(JSON.stringify(analyzeScreenshot(buf)));
  console.log(JSON.stringify(await page.evaluate(() => window.__render.stats())));
} finally {
  await browser.close();
  await server.close();
}
