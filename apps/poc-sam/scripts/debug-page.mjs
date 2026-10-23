// Debug helper: open one harness page, print every console message, run an
// expression, print its result. Not part of the benchmark.
//   node scripts/debug-page.mjs /bench-models.html "window.__runModelBench({...})" [timeoutMs]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , url = '/bench-models.html', expr = 'document.title', timeout = '120000'] = process.argv;
const server = await createServer({ configFile: path.join(HERE, '..', 'vite.config.mjs'), server: { port: 5481, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http ' + r.status() + '] ' + r.url()); });
  page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`http://localhost:5481${url}`);
  await page.waitForTimeout(1500);
  const result = await Promise.race([
    page.evaluate(expr),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Number(timeout))),
  ]);
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  await browser.close();
  await server.close();
}
