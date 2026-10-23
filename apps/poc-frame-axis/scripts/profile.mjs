/* global window -- page.evaluate callbacks run in the browser */
/**
 * CPU-profile one harness configuration while it scrolls, and print the
 * functions with the most self time. A diagnostic, not part of the bench.
 *
 *   node scripts/profile.mjs solid '{"frames":300,"width":512,"height":512,"annotationsPerFrame":10}'
 *   node scripts/profile.mjs vanilla '{"strategy":"mutable","drawer":"canvas",...}'
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [which = 'solid', json = '{}', port = '5532'] = process.argv.slice(2);
const opts = JSON.parse(json);
const server = await createServer({
  configFile: path.join(APP, 'vite.config.mjs'),
  server: { port: Number(port), strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const exe =
  process.env.BENCH_CHROMIUM ??
  (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(exe ? { executablePath: exe } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await (
    await browser.newContext({ viewport: { width: 900, height: 900 } })
  ).newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/${which === 'solid' ? 'solid.html' : 'index.html'}`);
  await page.waitForFunction('window.__poc && window.__poc.ready');
  await page.evaluate((o) => window.__poc.setup(o), opts);
  if (process.env.PROFILE_WARM) {
    await page.evaluate(() => window.__poc.scroll({ rate: 60, durationMs: 2000 }));
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const r = await page.evaluate(() => window.__poc.scroll({ rate: 60, durationMs: 2000 }));
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  const counts = new Map();
  profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) ?? 0) + (dt[i] ?? 0)));
  for (const [id, us] of counts) {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'}  ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ displayFps: r.displayFps, shown: r.shownSlicesPerSec }, null, 0));
  for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(
      `${((100 * us) / total).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)}ms  ${k}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
