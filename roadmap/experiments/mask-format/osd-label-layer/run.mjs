// Drives harness.js through every configuration; one fresh Chromium per page so memory is isolated.
// Usage: node run.mjs [filter-substring]   -> results/run-<tag>.json and results/all.json
import { chromium } from '/home/user/osdlabel/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs';
import { startServer } from './server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const filter = process.argv[2] || '';

let configs = [
  'osd=5&mode=base&drawer=canvas',
  'osd=5&mode=base&drawer=webgl',
  'osd=5&mode=osd-grid&d=128&drawer=canvas',
  'osd=5&mode=osd-grid&d=128&drawer=webgl',
  'osd=5&mode=osd-grid&d=8&drawer=canvas',
  'osd=5&mode=osd-grid&d=8&drawer=webgl',
  'osd=5&mode=osd-sparse&drawer=canvas',
  'osd=5&mode=osd-sparse&drawer=webgl',
  'osd=5&mode=fabric-grid&d=128&drawer=canvas',
  'osd=5&mode=fabric-grid&d=8&drawer=canvas',
  'osd=5&mode=multi-tiled&n=50&drawer=canvas',
  'osd=5&mode=multi-label&n=50&drawer=canvas',
  'osd=5&mode=multi-tiled&n=50&drawer=webgl',
  'osd=5&mode=multi-label&n=50&drawer=webgl',
  'osd=6&mode=osd-sparse&drawer=canvas',
  'osd=6&mode=osd-sparse&drawer=webgl',
].filter((c) => c.includes(filter));
// `node run.mjs qs:<query>` runs exactly that query string (extra variants such as mtpf=4).
if (filter.startsWith('qs:')) {
  configs.length = 0;
  configs.push(filter.slice(3));
}

function rssTree(rootPid) {
  const rows = execSync('ps -e -o pid=,ppid=,rss=,args=')
    .toString()
    .trim()
    .split('\n')
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] } : null;
    })
    .filter(Boolean);
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  let total = 0,
    gpu = 0,
    renderer = 0;
  const stack = [rootPid];
  const self = rows.find((r) => r.pid === rootPid);
  if (self) total += self.rss;
  while (stack.length) {
    const p = stack.pop();
    for (const c of kids.get(p) || []) {
      total += c.rss;
      if (c.args.includes('--type=gpu-process')) gpu += c.rss;
      if (c.args.includes('--type=renderer') && !c.args.includes('--extension-process'))
        renderer = Math.max(renderer, c.rss);
      stack.push(c.pid);
    }
  }
  return {
    totalMB: Math.round(total / 1024),
    gpuMB: Math.round(gpu / 1024),
    rendererMB: Math.round(renderer / 1024),
  };
}

const openBrowsers = new Set();
async function openPage(port, qs) {
  const tag = 'osdh' + Math.random().toString(36).slice(2);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--enable-precise-memory-info', `--osd-harness-tag=${tag}`],
  });
  openBrowsers.add(browser);
  const pidLine = execSync(
    `ps -e -o pid=,args= | grep -- '--osd-harness-tag=${tag}' | grep -v grep | head -1`,
  )
    .toString()
    .trim();
  const pid = Number(pidLine.split(/\s+/)[0]);
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 200));
  });
  await page.goto(`http://127.0.0.1:${port}/index.html?${qs}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return { browser, page, errors, pid };
}

let stepName = '';
async function ev(page, fn, arg) {
  const name = fn.toString().replace(/\s+/g, ' ').slice(0, 70);
  stepName = name;
  const t0 = Date.now();
  let timer;
  const r = await Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('step timeout: ' + name)), 90000);
    }),
  ]);
  clearTimeout(timer);
  if (process.env.VERBOSE) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${name}`);
  return r;
}

async function runConfig(port, qs) {
  const out = { qs, load1: os.loadavg()[0] };
  const mode = new URLSearchParams(qs).get('mode');
  const single = mode === 'osd-grid' || mode === 'osd-sparse';
  const fabric = mode === 'fabric-grid';
  const osd6 = qs.includes('osd=6');
  // Page A: overview first.
  {
    const { browser, page, errors, pid } = await openPage(port, qs);
    out.rssBlank = rssTree(pid);
    out.setup = await ev(page, () => H.setup());
    out.rssAfterBuild = rssTree(pid);
    const b = out.setup.boundary;
    out.firstFrameOverview = await ev(page, () => H.firstFrame());
    await ev(page, () => H.settle());
    out.rssAfterFirst = rssTree(pid);
    out.panOverview = await ev(page, () => H.panOverview());
    await ev(page, () => H.home());
    out.zoomOverview = await ev(page, () => H.zoomOverview());
    await ev(page, () => H.home());
    if (single) {
      out.rotateFlip = await ev(page, () => H.rotateFlip());
      await ev(page, () => H.home());
    }
    out.dive = await ev(page, () => H.dive());
    await ev(page, () => H.settle());
    out.memAfterDive = await ev(page, () => H.memory());
    await ev(page, () => H.oneToOne());
    out.pan11 = await ev(page, () => H.pan11());
    await ev(page, () => H.oneToOne());
    out.memAt11 = await ev(page, () => H.memory());
    out.rssAt11 = rssTree(pid);
    if (single || fabric) {
      const strat = fabric ? 'fabric-inplace' : 'inplace';
      out.stamp11 = await ev(page, ([b, s]) => H.stamp(b.x - 60, b.y, 150, s), [b, strat]);
      out.stroke11 = await ev(
        page,
        ([b, s]) => H.stroke(b.x - 100, b.y - 300, b.x - 100, b.y + 300, 60, 30, s),
        [b, strat],
      );
      if (fabric)
        out.stamp11Rebuild = await ev(
          page,
          ([b]) => H.stamp(b.x - 200, b.y + 100, 150, 'fabric-rebuild'),
          [b],
        );
      else {
        await ev(page, () => H.setForceFull(true));
        out.stamp11FullRepaint = await ev(
          page,
          ([b]) => H.stamp(b.x - 250, b.y - 250, 150, 'inplace'),
          [b],
        );
        await ev(page, () => H.setForceFull(false));
        out.stamp11Reset = await ev(page, ([b]) => H.stamp(b.x - 200, b.y + 100, 150, 'reset'), [
          b,
        ]);
        out.stamp11ResetNoNudge = await ev(
          page,
          ([b]) => H.stamp(b.x - 200, b.y + 300, 150, 'reset-nonudge'),
          [b],
        );
        await ev(page, () => H.home());
        await ev(page, () => H.oneToOne());
        if (osd6) {
          out.stamp11Osd6 = await ev(
            page,
            ([b]) => H.stamp(b.x - 300, b.y - 100, 150, 'osd6await'),
            [b],
          );
          out.stamp11Osd6Event = await ev(
            page,
            ([b]) => H.stamp(b.x - 300, b.y + 250, 150, 'osd6event'),
            [b],
          );
        }
      }
      out.hit11 = await ev(page, () => H.hitTest(200));
      if (single) out.outline11 = await ev(page, () => H.outline());
      await ev(page, () => H.home());
      out.stampOverview = await ev(page, ([b, s]) => H.stamp(b.x - 1000, b.y, 3000, s), [b, strat]);
      if (fabric)
        out.stampOverviewRebuild = await ev(
          page,
          ([b]) => H.stamp(b.x - 1000, b.y + 6000, 3000, 'fabric-rebuild'),
          [b],
        );
      out.hitOverview = await ev(page, () => H.hitTest(200));
      if (single) {
        out.selectionStyle = await ev(page, () => H.selectionStyle());
        out.outlineOverview = await ev(page, () => H.outline());
      }
    } else if (mode.startsWith('multi')) {
      await ev(page, () => H.home());
      out.hitOverview = await ev(page, () => H.hitTest(200));
    }
    out.memEnd = await ev(page, () => H.memory());
    out.rssEnd = rssTree(pid);
    out.errorsA = errors.slice(0, 10);
    await browser.close();
    openBrowsers.delete(browser);
  }
  // Page B: mask added while at 1:1 on the boundary.
  if (mode !== 'base') {
    const { browser, page, errors } = await openPage(port, qs);
    await ev(page, () => H.setup());
    await ev(page, () => H.oneToOne());
    out.firstFrame11 = await ev(page, () => H.firstFrame());
    out.errorsB = errors.slice(0, 10);
    await browser.close();
    openBrowsers.delete(browser);
  }
  return out;
}

const port = 5300 + Math.floor(Math.random() * 400);
const server = await startServer(port);
const all = {};
for (const qs of configs) {
  const tag = qs.replace(/[^a-z0-9]+/gi, '_');
  const t0 = Date.now();
  try {
    const r = await runConfig(port, qs);
    r.wallS = Math.round((Date.now() - t0) / 1000);
    all[qs] = r;
    fs.writeFileSync(path.join(here, 'results', `run-${tag}.json`), JSON.stringify(r, null, 1));
    console.log(`${qs}: ok ${r.wallS}s load1=${r.load1.toFixed(2)}`);
  } catch (e) {
    console.log(`${qs}: FAILED ${e.message.slice(0, 300)}`);
    all[qs] = { error: e.message };
    for (const br of openBrowsers) await br.close().catch(() => {});
    openBrowsers.clear();
  }
}
const allPath = path.join(
  here,
  'results',
  filter ? `all-${filter.replace(/[^a-z0-9]+/gi, '_')}.json` : 'all.json',
);
fs.writeFileSync(allPath, JSON.stringify(all, null, 1));
server.close();
console.log('wrote', allPath);
process.exit(0);
