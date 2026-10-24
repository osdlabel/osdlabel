/**
 * Video PoC benchmark: one non-interactive command.
 *
 *   pnpm --filter @osdlabel/poc-video bench [-- flags]
 *
 * 1. Builds the workspace packages this app imports (turbo, cached), unless
 *    --no-build.
 * 2. Generates the synthetic videos (scripts/gen-videos.py) if media/ lacks them.
 * 3. Serves the pages with Vite (cross-origin isolated, http://localhost).
 * 4. Runs, in one Chromium:
 *      H1  seek accuracy + latency: HTMLVideoElement policies vs
 *          @osdlabel/video's WebCodecsFrameSource vs mediabunny's
 *          VideoSampleSink; then paused-playback currentTime samples
 *      H2  1080p60 playback through each host (OSD canvas drawer with a
 *          tile copy or drawing the frame directly, OSD WebGL drawer, a
 *          CSS-transformed element under the overlay), 3 reps per cell
 *      H3  temporal tracks: interpolation cost (Node), the frame-axis writer
 *          study (Node, with H1's browser times), keyframes-as-annotations
 *          vs TrackDocument (Node), and the scrub harness
 * 5. Writes results/run-<stamp>.json and prints summary tables.
 *
 * Modules that import workspace packages are loaded with `import()` after
 * the build step, so a clean checkout runs (review: the static imports ran
 * before the build and failed with ERR_MODULE_NOT_FOUND).
 *
 * Flags:
 *   --only h1,h2,h3        which parts (default all)
 *   --videos a,b           H1 subset of media names (default: the 12-video H1 matrix)
 *   --n 40                 ops per H1 pattern
 *   --pauses 40            paused-playback samples per H1 video (0 to skip)
 *   --h2-seconds 6         seconds per H2 cell
 *   --h2-reps 3            repetitions per H2 cell
 *   --h2-video name        H2 source (default h264-1080p-60-g60-bf)
 *   --h2-combos a/b,c/d    H2 subset, e.g. osd-canvas/video,css/video
 *   --h2-motions m,n       H2 motions (default static,panzoom,fastpan)
 *   --h1-cells a/b,...     H1 video-element subset, e.g. forward/increment@boundary
 *   --h1-no-webcodecs      skip the WebCodecs and VideoSampleSink cells of H1
 *   --chromium <path>      browser binary (default /opt/pw-browsers/chromium,
 *                          or BENCH_CHROMIUM). Use your desktop Chrome on real
 *                          hardware, e.g. --chromium "/Applications/Google
 *                          Chrome.app/Contents/MacOS/Google Chrome" --headed
 *   --headed               show the browser (real GPU, real vsync)
 *   --port 5420
 *   --no-build
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { summarizeH1, poolH1, printTable } from './summarize.mjs';
import { mulberry32 } from './rng.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const MEDIA_DIR = path.join(APP_DIR, 'media');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} expects a value`);
  return v;
};

function randomTargets(n, frameCount, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  let prev = -1;
  while (out.length < n) {
    const t = Math.floor(rnd() * frameCount);
    if (t !== prev) out.push(t);
    prev = t;
  }
  return out;
}

const range = (from, n, step) => Array.from({ length: n }, (_, k) => from + k * step);

/** Media generated for H2 only (600 frames at 60 fps), not part of the 12-video H1 matrix. */
const H2_ONLY = new Set(['h264-1080p-60-g60-bf']);

async function runH1(page, manifest, names, n, { cells = null, skipWebcodecs = false } = {}) {
  const out = {};
  for (const name of names) {
    const v = manifest[name];
    const N = v.frameCount;
    const patterns = {
      random: randomTargets(n, N, 7),
      forward: range(100, n, 1),
      backward: range(160, n, -1),
    };
    const cell = {
      video: name,
      codec: v.codec,
      size: `${v.width}x${v.height}`,
      gop: v.gop,
      bframes: v.bframes,
      vfr: v.vfr,
      fps: `${v.fpsNum}/${v.fpsDen}`,
      bytes: v.bytes,
      videoElement: {},
      webcodecs: {},
    };
    process.stderr.write(`H1 ${name}: video element`);
    for (const [pattern, targets] of Object.entries(patterns)) {
      // `increment` steps currentTime by 1/fps from the previous position;
      // `@mid` starts mid-frame (a seek that already landed well), `@boundary`
      // starts at i/fps (what a naive player does after loading).
      const policies =
        pattern === 'random'
          ? ['boundary', 'mid', 'table-mid']
          : ['boundary', 'mid', 'table-mid', 'increment@mid', 'increment@boundary'];
      for (const key of policies) {
        if (cells !== null && !cells.includes(`${pattern}/${key}`)) continue;
        const [policy, start = 'table-mid'] = key.split('@');
        const startPolicy = start === 'mid' ? 'table-mid' : start;
        // Position one frame before the walk (not measured), then walk.
        const pre =
          pattern === 'random'
            ? []
            : [{ target: targets[0] - (pattern === 'forward' ? 1 : -1), policy: startPolicy }];
        const ops = [
          ...pre,
          ...targets.map((target) => ({
            target,
            policy,
            ...(policy === 'increment' ? { dir: pattern === 'forward' ? 1 : -1 } : {}),
          })),
        ];
        const res = await page.evaluate(
          ([nm, o]) => window.__seek.videoElementRun(nm, o),
          [name, ops],
        );
        cell.videoElement[`${pattern}/${key}`] = res.slice(pre.length);
        process.stderr.write('.');
      }
    }
    if (skipWebcodecs) {
      process.stderr.write('\n');
      out[name] = cell;
      continue;
    }
    process.stderr.write(' webcodecs');
    const wcCells = [
      ['random', 0],
      ['forward', 0],
      ['backward', 0],
      ['backward', 64],
    ];
    for (const [pattern, cacheFrames] of wcCells) {
      const targets = patterns[pattern];
      const pre = pattern === 'random' ? [] : [targets[0] - (pattern === 'forward' ? 1 : -1)];
      const res = await page.evaluate(
        ([nm, t, c]) => window.__seek.webcodecsRun(nm, t, c),
        [name, [...pre, ...targets], cacheFrames],
      );
      cell.webcodecs[`${pattern}/cache${cacheFrames}`] = {
        ...res,
        results: res.results.slice(pre.length),
      };
      process.stderr.write('.');
    }
    // mediabunny's own VideoSampleSink.getSample(t), no cache, same targets.
    process.stderr.write(' sink');
    cell.sink = {};
    for (const pattern of ['random', 'forward', 'backward']) {
      const targets = patterns[pattern];
      const pre = pattern === 'random' ? [] : [targets[0] - (pattern === 'forward' ? 1 : -1)];
      const res = await page.evaluate(
        ([nm, t]) => window.__seek.sinkRun(nm, t),
        [name, [...pre, ...targets]],
      );
      cell.sink[pattern] = { ...res, results: res.results.slice(pre.length) };
      process.stderr.write('.');
    }
    process.stderr.write('\n');
    out[name] = cell;
  }
  return out;
}

async function runPauses(page, names, n) {
  const out = {};
  for (const name of names) {
    process.stderr.write(`pauses ${name}\n`);
    out[name] = await page.evaluate(([nm, k]) => window.__seek.playPauseRun(nm, k), [name, n]);
  }
  return out;
}

async function main() {
  const only = new Set(String(arg('--only', 'h1,h2,h3')).split(','));
  const n = Number(arg('--n', '40'));
  const port = Number(arg('--port', '5420'));
  const h2Seconds = Number(arg('--h2-seconds', '6'));
  const h2Reps = Number(arg('--h2-reps', '3'));
  const pauses = Number(arg('--pauses', '40'));
  const executablePath = arg(
    '--chromium',
    process.env.BENCH_CHROMIUM ?? '/opt/pw-browsers/chromium',
  );

  if (!flag('--no-build')) {
    process.stderr.write('building workspace dependencies (turbo, cached)...\n');
    execFileSync(
      'pnpm',
      [
        'exec',
        'turbo',
        'run',
        'build',
        '--filter=@osdlabel/poc-video^...',
        '--output-logs=errors-only',
      ],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
  }
  const manifestPath = path.join(MEDIA_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write('generating synthetic videos (first run only, a few minutes)...\n');
    execFileSync('python3', [path.join(APP_DIR, 'scripts', 'gen-videos.py')], { stdio: 'inherit' });
  }
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const needed = [...H2_ONLY].filter((nm) => manifest[nm] === undefined);
  if (needed.length > 0) {
    process.stderr.write(`generating ${needed.join(', ')}...\n`);
    execFileSync(
      'python3',
      [path.join(APP_DIR, 'scripts', 'gen-videos.py'), '--only', needed.join(',')],
      {
        stdio: 'inherit',
      },
    );
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  const names =
    arg('--videos', null)?.split(',') ?? Object.keys(manifest).filter((nm) => !H2_ONLY.has(nm));
  // Loaded after the build, and only for the parts that run: these import
  // @osdlabel/* dist/ (and mediabunny).
  const h3 = only.has('h3');
  const { runTemporalBench } = h3 ? await import('./temporal-bench.mjs') : {};
  const { runAxisStudy } = h3 ? await import('./axis-study.mjs') : {};
  const { runKeyframeAnnotationsBench } = h3
    ? await import('./keyframe-annotations-bench.mjs')
    : {};
  const { runH2 } = only.has('h2') ? await import('./render-bench.mjs') : {};
  const { runH3Harness } = h3 ? await import('./tracks-bench.mjs') : {};

  const result = {
    meta: {
      startedAt: new Date().toISOString(),
      host: {
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
        memGB: Math.round(os.totalmem() / 1e9),
        platform: `${os.platform()} ${os.release()}`,
        loadavgAtStart: os.loadavg(),
      },
      node: process.version,
      chromium: executablePath,
      headed: flag('--headed'),
      n,
      gitHead: (() => {
        try {
          return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
        } catch {
          return null;
        }
      })(),
      // Uncommitted changes under the measured code (review: a run recorded a
      // head whose measured code had uncommitted edits).
      gitDirty: (() => {
        try {
          return execFileSync(
            'git',
            ['status', '--porcelain', '--', 'apps/poc-video', 'packages'],
            {
              cwd: REPO_ROOT,
            },
          )
            .toString()
            .split('\n')
            .filter((l) => l.length > 0 && !l.includes('apps/poc-video/results/'));
        } catch {
          return null;
        }
      })(),
    },
  };

  if (only.has('h3')) {
    process.stderr.write('H3 temporal interpolation cost and keyframe storage (Node)...\n');
    result.h3 = { node: await runTemporalBench() };
  }

  // The config inline (configFile: false) with no file watching and no HMR:
  // an edit, a rebuild or a config change during a long run must not reload
  // the page under test or restart the server mid-run (a config edit killed
  // one H1 run this way). Passing `watch: null` over the config file does not
  // work: Vite's config merge skips null overrides.
  const { default: viteConfig } = await import('../vite.config.mjs');
  const server = await createServer({
    ...viteConfig,
    configFile: false,
    server: {
      ...viteConfig.server,
      port,
      strictPort: true,
      host: 'localhost',
      hmr: false,
      watch: null,
    },
  });
  await server.listen();
  const base = `http://localhost:${port}`;
  const browser = await chromium.launch({
    executablePath,
    headless: !flag('--headed'),
    args: [
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--ignore-gpu-blocklist',
    ],
  });
  try {
    result.meta.browserVersion = browser.version();
    if (only.has('h1')) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => process.stderr.write(`[seek pageerror] ${e.message}\n`));
      await page.goto(`${base}/seek.html`);
      await page.waitForFunction(() => window.__seek !== undefined);
      result.meta.env = await page.evaluate(() => window.__seek.env());
      result.h1 = await runH1(page, manifest, names, n, {
        cells: arg('--h1-cells', null)?.split(',') ?? null,
        skipWebcodecs: flag('--h1-no-webcodecs'),
      });
      if (pauses > 0) result.h1Pauses = await runPauses(page, names, pauses);
      await page.close();
    }
    if (only.has('h3')) {
      process.stderr.write('H3 frame-axis writer study (Node)...\n');
      result.h3.axis = await runAxisStudy(manifest, MEDIA_DIR, {
        h1: result.h1 ?? null,
        pauses: result.h1Pauses ?? null,
      });
    }
    if (only.has('h2')) {
      result.h2 = await runH2(browser, base, {
        seconds: h2Seconds,
        reps: h2Reps,
        video: arg('--h2-video', 'h264-1080p-60-g60-bf'),
        combos: arg('--h2-combos', null)?.split(',') ?? null,
        motions: arg('--h2-motions', null)?.split(',') ?? null,
      });
    }
    if (only.has('h3')) {
      result.h3.keyframes = await runKeyframeAnnotationsBench(browser, base);
      result.h3.harness = await runH3Harness(browser, base);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  result.meta.host.loadavgAtEnd = os.loadavg();
  result.meta.finishedAt = new Date().toISOString();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = result.meta.startedAt.replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `run-${stamp}.json`);
  if (result.h1) {
    result.h1Summary = summarizeH1(result.h1);
    result.h1Pooled = poolH1(result.h1);
  }
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  printTable(result);
  process.stderr.write(`\nwrote ${path.relative(process.cwd(), file)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
