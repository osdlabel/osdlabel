/**
 * Within-build A/B for the HUD (cell-anchored) code path.
 *
 * Runs ONE build twice per scenario: once with the HUD rows emitted as real
 * cell-anchored decorations (the code path under test) and once with the exact
 * same number of decorations emitted as plain image-space text, which never
 * reads the host box. Everything else is identical, so the difference isolates
 * the cell-space branch of `_reposition`.
 *
 *   node scripts/probe-hud.mjs [--root <path>] [--scenarios S2,S5]
 *                              [--frames 240] [--reps 3] [--port 5398]
 *                              [--chromium <path>]
 *
 * Skips with a message when the build under test has no cell-anchor support.
 */
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { arg, resolveChromium, CONFIG_FILE, REPO_ROOT } from './run.mjs';

const argv = process.argv.slice(2);
const root = path.resolve(arg(argv, '--root', process.env.BENCH_ROOT ?? REPO_ROOT));
const scenarios = String(arg(argv, '--scenarios', 'S2,S5')).split(',');
const frames = Number(arg(argv, '--frames', '240'));
const reps = Number(arg(argv, '--reps', '3'));
const port = Number(arg(argv, '--port', '5398'));

process.env.BENCH_ROOT = root;
const server = await createServer({
  configFile: CONFIG_FILE,
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();

const browser = await chromium.launch({
  executablePath: resolveChromium(arg(argv, '--chromium', undefined)),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction('window.__bench !== undefined');
await page.evaluate('window.__bench.ready');

const supportsCell = await page.evaluate('window.__bench.supportsCellAnchor()');
if (!supportsCell) {
  console.log(`build at ${root} has no cell-anchor support — nothing to A/B`);
} else {
  const runOne = (scenario, hudMode) =>
    page.evaluate(
      ({ scenario, hudMode, frameCount }) =>
        window.__bench.run({ scenario, hudMode, frameCount, phases: ['live', 'static'] }),
      { scenario, hudMode, frameCount: frames },
    );

  for (const s of scenarios) {
    for (const mode of ['image', 'cell']) {
      await runOne(s, mode); // warm
      const rs = [];
      for (let i = 0; i < reps; i++) rs.push(await runOne(s, mode));
      const m = (p) =>
        rs.map((r) => r.phases[p].reposition.median).sort((a, b) => a - b)[Math.floor(reps / 2)];
      console.log(
        `${s} hud=${mode}: live=${m('live').toFixed(0)}µs static=${m('static').toFixed(0)}µs ` +
          `liveWrites=${rs[rs.length - 1].phases.live.transformWrites}`,
      );
    }
  }
}

await browser.close();
await server.close();
