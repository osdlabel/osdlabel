/**
 * Bench driver.
 *
 * Starts one Vite dev server per build (each pointed at a different checkout
 * via BENCH_ROOT), opens one page against each in a single local Chromium, and
 * runs the scenario matrix interleaved (build A, build B, build A, …) so
 * thermal/GC drift is shared between them.
 *
 * CLI:
 *   node scripts/run.mjs [--root <path>] [--label <name>]
 *                        [--build <label>=<path> ...]
 *                        [--reps 7] [--frames 240]
 *                        [--scenarios S0,S1,…] [--phases pan,static,live]
 *                        [--trace] [--out <dir>] [--port-base 5390]
 *                        [--chromium <path>] [--allow-degraded]
 *
 * With no --root/--build it measures the checkout this file lives in.
 * The run aborts before the matrix when a measurement prerequisite fails
 * (transform-write hook, cross-origin isolation, timer resolution); pass
 * --allow-degraded to run anyway, in which case meta.json records why the
 * numbers are not comparable.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

export const BENCH_APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(BENCH_APP_DIR, '..', '..');
export const CONFIG_FILE = path.join(BENCH_APP_DIR, 'vite.config.mjs');
export const RESULTS_DIR = path.join(BENCH_APP_DIR, 'results');

export const ALL_SCENARIOS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
export const ALL_PHASES = ['pan', 'static', 'live'];
export const DEFAULT_PORT_BASE = 5390;
/** Coarsest `performance.now()` the analysis's sub-quantum rules are valid for. */
export const MAX_TIMER_RESOLUTION_US = 10;

/**
 * `--flag value` lookup over an argv array. A flag given without a value (last
 * in argv, or followed by another `--flag`) is an error rather than silently
 * becoming `undefined` or swallowing the next flag.
 */
export function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} expects a value`);
  return v;
}

/** `arg()` parsed as a positive integer; anything else is an error. */
export function intArg(argv, flag, fallback) {
  const raw = arg(argv, flag, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} expects a positive integer, got: ${raw}`);
  }
  return n;
}

/** A comma-separated `arg()` whose every entry must be one of `allowed`. */
export function listArg(argv, flag, allowed) {
  const list = String(arg(argv, flag, allowed.join(','))).split(',');
  const unknown = list.filter((x) => !allowed.includes(x));
  if (unknown.length || list.length === 0) {
    throw new Error(
      `${flag}: unknown ${unknown.join(', ')} (expected any of ${allowed.join(',')})`,
    );
  }
  return list;
}

/**
 * Build labels become result file names (`<label>.json`) and meta.json keys,
 * so they must be file-name safe and unique. A branch name like `feat/x`
 * would otherwise fail only when the results are written, after the whole
 * matrix has run, and two equal labels would silently merge their results.
 */
export function validateLabels(names) {
  for (const n of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(n)) {
      throw new Error(`build label '${n}' must match [A-Za-z0-9._-]+ (it becomes a file name)`);
    }
  }
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`duplicate build label '${dup}'`);
}

/** All `--flag value` occurrences, in order. */
export function argAll(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1]);
  return out;
}

export function shortSha(root, ref = 'HEAD') {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', ref], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return path.basename(root);
  }
}

/**
 * Resolve the Chromium binary.
 *
 * Defaults to Playwright's own download. `BENCH_CHROMIUM` / `--chromium`
 * override it — this session needed the override because the pinned revision
 * could not be downloaded here; CI, which installs browsers normally, will not.
 */
export function resolveChromium(explicit) {
  const p = explicit ?? process.env.BENCH_CHROMIUM ?? chromium.executablePath();
  if (!p) throw new Error('no chromium executable resolved; pass --chromium <path>');
  return p;
}

export function timestampDir(base = RESULTS_DIR) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(base, stamp);
}

/** How long the page may take to open the sample image before the run aborts. */
export const READY_TIMEOUT_MS = 60000;

/**
 * Await the page's `__bench.ready`, which rejects on OSD `open-failed`, with a
 * timeout: `page.evaluate` has none of its own, so a viewer that never opens
 * would otherwise hang the run.
 */
export function waitReady(page, timeoutMs = READY_TIMEOUT_MS) {
  return page.evaluate(
    (ms) =>
      Promise.race([
        window.__bench.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`viewer did not open within ${ms} ms`)), ms),
        ),
      ]),
    timeoutMs,
  );
}

async function startServer(build) {
  process.env.BENCH_ROOT = build.root; // read by vite.config.mjs at load time
  const server = await createServer({
    configFile: CONFIG_FILE,
    server: { port: build.port, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  return server;
}

/**
 * Run the matrix over one or more builds.
 *
 * @param {object} options
 * @param {Array<{name: string, root: string}>} options.builds
 * @returns {Promise<{out: string, meta: object, results: Record<string, object[]>}>}
 */
export async function runBench({
  builds,
  reps = 7,
  frames = 240,
  scenarios = ALL_SCENARIOS,
  phases = ALL_PHASES,
  trace = false,
  allowDegraded = false,
  out = timestampDir(),
  portBase = DEFAULT_PORT_BASE,
  chromiumPath,
  log = console.log,
}) {
  validateLabels(builds.map((b) => b.name));
  const chromeExe = resolveChromium(chromiumPath);
  fs.mkdirSync(out, { recursive: true });

  const plan = builds.map((b, i) => ({ ...b, root: path.resolve(b.root), port: portBase + i }));

  const browser = await chromium.launch({
    executablePath: chromeExe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  const ctxs = [];
  try {
    for (const build of plan) {
      build.server = await startServer(build);
      const context = await browser.newContext({ viewport: { width: 1000, height: 780 } });
      const page = await context.newPage();
      page.on('requestfailed', (r) => console.error(`[${build.name}] reqfail ${r.url()}`));
      page.on('response', (r) => {
        if (r.status() >= 400) console.error(`[${build.name}] HTTP ${r.status()} ${r.url()}`);
      });
      page.on('pageerror', (e) => console.error(`[${build.name}] pageerror`, e.message));
      await page.goto(`http://127.0.0.1:${build.port}/index.html`, { waitUntil: 'load' });
      await page.waitForFunction('window.__bench !== undefined', null, { timeout: 60000 });
      await waitReady(page);
      const hookOk = await page.evaluate('window.__bench.transformHookOk()');
      const coi = await page.evaluate('window.__bench.crossOriginIsolated()');
      const timerUs = await page.evaluate('window.__bench.timerResolutionUs()');
      const loadedRoot = await page.evaluate('window.__bench.root');
      if (loadedRoot !== build.root) throw new Error(`build mixup: ${loadedRoot} != ${build.root}`);
      // Capability probe, not a build-name check: decides how the HUD rows of
      // S5/S6/S7 are emitted on this build.
      build.cellAnchor = await page.evaluate('window.__bench.supportsCellAnchor()');
      build.hudMode = build.cellAnchor ? 'cell' : 'image';
      build.hostCached = await page.evaluate('window.__bench.hostSizeCached()');
      log(
        `[${build.name}] ready  root=${loadedRoot}  hook=${hookOk}  crossOriginIsolated=${coi}  ` +
          `timerRes=${timerUs.toFixed(2)}µs  hud=${build.hudMode}`,
      );
      // The analysis assumes exact write counts and a ~5 µs clock (its
      // sub-quantum rules are written for 5/10 µs). Without these the output
      // would look authoritative and be meaningless, so refuse to run unless
      // the caller explicitly accepts a degraded measurement.
      const failed = [];
      if (!hookOk) failed.push('transform-write hook did not install (write counts would be 0)');
      if (!coi)
        failed.push('page is not cross-origin isolated (performance.now() clamped to 100 µs)');
      if (timerUs > MAX_TIMER_RESOLUTION_US) {
        failed.push(
          `timer resolution ${timerUs.toFixed(2)} µs exceeds ${MAX_TIMER_RESOLUTION_US} µs`,
        );
      }
      if (failed.length) {
        const msg = `[${build.name}] measurement prerequisites failed:\n  - ${failed.join('\n  - ')}`;
        if (!allowDegraded) throw new Error(`${msg}\nPass --allow-degraded to run anyway.`);
        console.warn(
          `${msg}\nContinuing because --allow-degraded was passed; results are NOT comparable.`,
        );
        build.degraded = failed;
      }
      build.page = page;
      build.hookOk = hookOk;
      build.coi = coi;
      build.timerUs = timerUs;
      ctxs.push(context);
    }

    const results = Object.fromEntries(plan.map((b) => [b.name, []]));

    // Warm-up: 1 short run per scenario per build, discarded.
    for (const s of scenarios) {
      for (const build of plan) {
        await build.page.evaluate(
          ({ scenario, hudMode, frameCount, phaseList }) =>
            window.__bench.run({ scenario, hudMode, frameCount, phases: phaseList }),
          {
            scenario: s,
            hudMode: build.hudMode,
            frameCount: Math.min(60, frames),
            phaseList: phases,
          },
        );
      }
    }
    log('warm-up done');

    for (let rep = 0; rep < reps; rep++) {
      for (const s of scenarios) {
        for (const build of plan) {
          const t = Date.now();
          const r = await build.page.evaluate(
            ({ scenario, hudMode, frameCount, phaseList }) =>
              window.__bench.run({ scenario, hudMode, frameCount, phases: phaseList }),
            { scenario: s, hudMode: build.hudMode, frameCount: frames, phaseList: phases },
          );
          r.rep = rep;
          results[build.name].push(r);
          log(
            `rep ${rep} ${s} ${build.name}: ` +
              phases
                .map(
                  (p) =>
                    `${p}=${r.phases[p].reposition.median.toFixed(1)}µs/${r.phases[p].transformWrites}w`,
                )
                .join(' ') +
              ` (${((Date.now() - t) / 1000).toFixed(1)}s)`,
          );
        }
      }
    }

    // ── separate traced pass for Layout / UpdateLayoutTree counts ────────
    // Kept out of the timing loop: the timeline category produces ~1M events
    // per run and would perturb the very timings it measures.
    if (trace) {
      for (const s of scenarios) {
        for (const build of plan) {
          const client = await build.page.context().newCDPSession(build.page);
          const events = [];
          // A loop, not push(...d.value): a large chunk spread as arguments
          // can overflow the call stack.
          client.on('Tracing.dataCollected', (d) => {
            for (const e of d.value) events.push(e);
          });
          const done = new Promise((r) => client.once('Tracing.tracingComplete', r));
          await client.send('Tracing.start', {
            categories: 'disabled-by-default-devtools.timeline',
            transferMode: 'ReportEvents',
          });
          await build.page.evaluate(
            ({ scenario, hudMode, frameCount, phaseList }) =>
              window.__bench.run({ scenario, hudMode, frameCount, phases: phaseList }),
            { scenario: s, hudMode: build.hudMode, frameCount: frames, phaseList: phases },
          );
          await client.send('Tracing.end');
          await done;
          const counts = {};
          for (const e of events) {
            if (e.ph === 'X' || e.ph === 'B') {
              if (e.name === 'Layout' || e.name === 'UpdateLayoutTree' || e.name === 'ParseHTML')
                counts[e.name] = (counts[e.name] ?? 0) + 1;
            }
          }
          log(`trace ${s} ${build.name}:`, JSON.stringify(counts), `(${events.length} evts)`);
          fs.writeFileSync(
            path.join(out, `trace-${build.name}-${s}.json`),
            JSON.stringify(
              { scenario: s, build: build.name, counts, total: events.length },
              null,
              2,
            ),
          );
          await client.detach();
        }
      }
    }

    const meta = {
      date: new Date().toISOString(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalMemGB: +(os.totalmem() / 1e9).toFixed(1),
      chromium: chromeExe,
      headless: true,
      reps,
      frames,
      scenarios,
      phases,
      traced: trace,
      labels: plan.map((b) => b.name),
      baseLabel: plan.length > 1 ? plan[0].name : null,
      headLabel: plan[plan.length - 1].name,
      hudMode: Object.fromEntries(plan.map((b) => [b.name, b.hudMode])),
      cellAnchorSupport: Object.fromEntries(plan.map((b) => [b.name, b.cellAnchor])),
      hostSizeCached: Object.fromEntries(plan.map((b) => [b.name, b.hostCached])),
      transformHookOk: Object.fromEntries(plan.map((b) => [b.name, b.hookOk])),
      degraded: Object.fromEntries(plan.map((b) => [b.name, b.degraded ?? null])),
      crossOriginIsolated: Object.fromEntries(plan.map((b) => [b.name, b.coi])),
      timerResolutionUs: Object.fromEntries(plan.map((b) => [b.name, b.timerUs])),
      builds: Object.fromEntries(plan.map((b) => [b.name, b.root])),
      commits: Object.fromEntries(plan.map((b) => [b.name, shortSha(b.root)])),
    };
    fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
    for (const b of plan) {
      fs.writeFileSync(path.join(out, `${b.name}.json`), JSON.stringify(results[b.name], null, 2));
    }
    log('written to', out);
    return { out, meta, results };
  } finally {
    for (const c of ctxs) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    for (const b of plan) await b.server?.close().catch(() => {});
  }
}

/** Parse the shared CLI flags used by both run.mjs and compare.mjs. */
// Validated up front: a non-numeric --frames would make the page's rAF loop
// never finish, and --reps 0 would produce empty results that analyze cannot
// gate on.
export function parseCommonArgs(argv) {
  return {
    reps: intArg(argv, '--reps', 7),
    frames: intArg(argv, '--frames', 240),
    scenarios: listArg(argv, '--scenarios', ALL_SCENARIOS),
    phases: listArg(argv, '--phases', ALL_PHASES),
    trace: argv.includes('--trace'),
    allowDegraded: argv.includes('--allow-degraded'),
    portBase: intArg(argv, '--port-base', DEFAULT_PORT_BASE),
    chromiumPath: arg(argv, '--chromium', undefined),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const common = parseCommonArgs(argv);
  const explicit = argAll(argv, '--build').map((spec) => {
    const eq = spec.indexOf('=');
    if (eq === -1) throw new Error(`--build expects <label>=<path>, got: ${spec}`);
    return { name: spec.slice(0, eq), root: path.resolve(spec.slice(eq + 1)) };
  });
  const builds = explicit.length
    ? explicit
    : (() => {
        const root = path.resolve(arg(argv, '--root', process.env.BENCH_ROOT ?? REPO_ROOT));
        return [{ name: arg(argv, '--label', shortSha(root)), root }];
      })();
  const out = path.resolve(arg(argv, '--out', timestampDir()));
  await runBench({ ...common, builds, out });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
