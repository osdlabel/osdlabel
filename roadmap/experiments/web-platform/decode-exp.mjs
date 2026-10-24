// Reviewer experiment: decoder latency per click, worker vs main thread, t=1 vs t=4,
// many reps, via the PoC's own e2e harness (cache-hit clicks only).
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const APP = '/home/user/osdlabel/.claude/worktrees/wf_182118f9-0ad-5/apps/poc-sam';
const req = createRequire(path.join(APP, 'package.json'));
const { createServer } = await import(req.resolve('vite'));
const pw = await import(req.resolve('playwright'));
const chromium = pw.chromium ?? pw.default.chromium;
const { pickTargets } = await import(path.join(APP, 'scripts/scene-targets.mjs'));

const PORT = Number(process.env.PORT ?? 5499);
const REPS = Number(process.env.REPS ?? 30);
const MODEL = process.env.MODEL ?? 'mobile_sam';
const CONFIGS = (process.env.CONFIGS ?? 'local:1,local:4,local-main:1,local-main:4')
  .split(',')
  .map((s) => {
    const [mode, t] = s.split(':');
    return { mode, threads: Number(t) };
  });

const server = await createServer({
  configFile: path.join(APP, 'vite.config.mjs'),
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const T = pickTargets();
const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const out = [];
for (const cfg of CONFIGS) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/e2e.html`);
  await page.waitForFunction(() => typeof window.__e2e === 'object', null, { timeout: 60000 });
  await page.evaluate(
    (c) => window.__e2e.init({ image: 'synth', model: c.model, mode: c.mode, threads: c.threads }),
    {
      ...cfg,
      model: MODEL,
    },
  );
  const zoom = 1280 / 10000;
  await page.evaluate((v) => window.__e2e.view(v), { cx: T.gland.x, cy: T.gland.y, zoom });
  const clickOnce = async () => {
    const from = await page.evaluate(() => window.__e2e.mark());
    const s = await page.evaluate((p) => window.__e2e.toScreen(p), { x: T.gland.x, y: T.gland.y });
    await page.mouse.click(s.x, s.y);
    const ev = await page.evaluate(([f]) => window.__e2e.waitPainted(f, 300000), [from]);
    await page.evaluate(() => window.__e2e.cancel());
    const r = ev.find((e) => e.type === 'result');
    const p = ev.find((e) => e.type === 'painted');
    const fr = ev.find((e) => e.type === 'frames');
    return {
      cached: r?.cached,
      decode: r?.timings?.decode,
      painted: p?.latency,
      encode: r?.timings?.encode,
      maxGap: fr?.maxGap,
      fps: fr?.fps,
    };
  };
  const first = await clickOnce();
  const dec = [];
  const painted = [];
  const gaps = [];
  const load0 = os.loadavg()[0];
  for (let i = 0; i < REPS; i++) {
    const r = await clickOnce();
    if (!r.cached) {
      console.log('unexpected miss', r);
      continue;
    }
    dec.push(r.decode);
    painted.push(r.painted);
    gaps.push(r.maxGap);
  }
  const row = {
    ...cfg,
    model: MODEL,
    first,
    n: dec.length,
    load: [load0, os.loadavg()[0]],
    decode: {
      p50: q(dec, 0.5),
      p90: q(dec, 0.9),
      p95: q(dec, 0.95),
      min: Math.min(...dec),
      max: Math.max(...dec),
    },
    painted: {
      p50: q(painted, 0.5),
      p90: q(painted, 0.9),
      p95: q(painted, 0.95),
      min: Math.min(...painted),
    },
    maxGap: { p50: q(gaps, 0.5), max: Math.max(...gaps) },
  };
  out.push(row);
  console.log(JSON.stringify(row));
  await context.close();
}
fs.writeFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), `decode-exp-${Date.now()}.json`),
  JSON.stringify(out, null, 1),
);
await browser.close();
await server.close();
