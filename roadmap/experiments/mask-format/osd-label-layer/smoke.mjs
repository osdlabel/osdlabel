// Smoke test: one config, screenshots at overview and 1:1. Usage: node smoke.mjs "mode=osd-sparse&drawer=canvas"
import { chromium } from '/home/user/osdlabel/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs';
import { startServer } from './server.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const qs = process.argv[2] || 'mode=osd-sparse&drawer=canvas';
const tag = qs.replace(/[^a-z0-9]+/gi, '_');
const port = 5288 + Math.floor(Math.random() * 500);
const server = await startServer(port);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  args: ['--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    console.log('[console]', m.type(), m.text().slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/index.html?${qs}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const setup = await page.evaluate(() => H.setup());
console.log('setup', JSON.stringify(setup));
const ff = await page.evaluate(() => H.firstFrame());
console.log('firstFrame overview', JSON.stringify(ff));
await page.screenshot({ path: path.join(here, 'results', `smoke-${tag}-overview.png`) });
await page.evaluate(() => H.oneToOne());
await page.screenshot({ path: path.join(here, 'results', `smoke-${tag}-1to1.png`) });
const st = await page.evaluate(
  ([b, mode]) => H.stamp(b.x - 60, b.y, 150, mode === 'fabric-grid' ? 'fabric-inplace' : 'inplace'),
  [setup.boundary, setup.mode],
);
console.log('stamp', JSON.stringify(st));
await page.screenshot({ path: path.join(here, 'results', `smoke-${tag}-stamp.png`) });
await browser.close();
server.close();
