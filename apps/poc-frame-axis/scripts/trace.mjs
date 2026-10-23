/* global window -- page.evaluate callbacks run in the browser */
/**
 * Record a Chrome timeline trace of one harness configuration while it
 * scrolls, and print where the renderer main thread's time went by trace
 * event name (style, layout, paint, script, GC, …). A diagnostic, not part
 * of the bench: it answers what a CPU profile files under "(program)".
 *
 *   node scripts/trace.mjs solid '{"drawer":"canvas","annotationsPerFrame":50,...}'
 *   node scripts/trace.mjs vanilla '{"strategy":"mutable","drawer":"canvas",...}'
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [which = 'solid', json = '{}', port = '5533'] = process.argv.slice(2);
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
  await page.goto(`http://127.0.0.1:${port}/${which === 'solid' ? 'solid.html' : 'index.html'}`);
  await page.waitForFunction('window.__poc && window.__poc.ready');
  await page.evaluate((o) => window.__poc.setup(o), opts);
  await browser.startTracing(page, {
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'v8',
      'blink.user_timing',
    ],
  });
  const r = await page.evaluate(() => window.__poc.scroll({ rate: 60, durationMs: 2000 }));
  const buf = await browser.stopTracing();
  const trace = JSON.parse(buf.toString());
  const events = trace.traceEvents ?? trace;
  // Renderer main thread: the thread named CrRendererMain.
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const self = new Map();
  // Self time per top-level-ish event: sum durations of complete events on the main thread,
  // attributing nested time to the innermost event.
  const xs = events
    .filter((e) => e.ph === 'X' && e.pid === main?.pid && e.tid === main?.tid && e.dur)
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stack = [];
  for (const e of xs) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts)
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) self.set(parent.name, (self.get(parent.name) ?? 0) - e.dur);
    self.set(e.name, (self.get(e.name) ?? 0) + e.dur);
    stack.push(e);
  }
  const total = [...self.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
  console.log(
    JSON.stringify({
      displayFps: r.displayFps,
      shown: r.shownSlicesPerSec,
      mainThreadBusyMs: Math.round(total / 1000),
    }),
  );
  for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`${(us / 1000).toFixed(0).padStart(6)}ms  ${k}`);
  }
} finally {
  await browser.close();
  await server.close();
}
