#!/usr/bin/env node
/* global window, document, getComputedStyle, performance */
/**
 * The element PoC's one-command benchmark.
 *
 *   pnpm --filter @osdlabel/poc-element bench
 *   pnpm --filter @osdlabel/poc-element bench -- --reps 7 --only sizes,tti,css
 *
 * Prerequisite: the packages' dist/ (the bench measures built code, like E2E):
 *   pnpm exec turbo run build --filter=@osdlabel/element --filter=@osdlabel/react
 *
 * Three measurements, written together to results/bench-<timestamp>.json and
 * results/latest.json, with a summary table on stdout:
 *
 *  sizes  Production bundles (Vite 8 / Rolldown, default minifier) of one
 *         entry per variant, summed over every emitted JS/CSS file, raw, gzip -9
 *         and brotli q11: the Solid binding vs the custom element (hand-rolled
 *         and solid-element), the React binding, each wrapper alone (shared
 *         code external), and each host framework page.
 *  tti    Time to first interactive cell, per host page: navigation start to
 *         "cell 0's image is open, its first tiled image fully loaded and the
 *         Fabric overlay attached" (src/shared/probe.ts), in a fresh browser
 *         context per sample (cold HTTP cache). Hosts are rotated every rep so
 *         each occupies each position equally. CDP Performance metrics give
 *         the CPU-side split (script, layout, style, task).
 *  css    CSS isolation: the lab page under Bootstrap 5.3 and Tailwind 4
 *         preflight, in shadow and light DOM; computed styles of every element
 *         in the annotator vs the same mode without host CSS, plus whether a
 *         drawn rectangle's image-space geometry changes.
 *
 * Chromium: --chromium <path> or POC_CHROMIUM, default /opt/pw-browsers/chromium
 * (the sandbox's). On a desktop pass Chrome's binary, e.g.
 *   --chromium "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   --chromium /usr/bin/google-chrome
 * or --chromium playwright to use Playwright's own download.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import vue from '@vitejs/plugin-vue';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { compressedSizes, diffStyleSignatures, kib, summarize, table } from './lib/stats.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = path.join(APP_DIR, '.bench-build');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const REPS = Number(arg('--reps', '7'));
const PORT = Number(arg('--port', '5475'));
const ONLY = new Set(String(arg('--only', 'sizes,tti,css')).split(','));
const CHROMIUM_ARG = arg('--chromium', process.env.POC_CHROMIUM ?? '/opt/pw-browsers/chromium');
const EXECUTABLE = CHROMIUM_ARG === 'playwright' ? undefined : CHROMIUM_ARG;

// ── sizes ───────────────────────────────────────────────────────────────────

/** Packages the "wrapper only" variants treat as already paid for. */
const SHARED_EXTERNALS = [
  /^@osdlabel\/(?!element)/,
  /^osdlabel(\/|$)/,
  /^solid-js(\/|$)/,
  'fabric',
  'openseadragon',
];

const SIZE_VARIANTS = [
  {
    name: 'solid-binding',
    what: '@osdlabel/solid <Annotator> mounted with solid-js/web render (everything bundled)',
    source: `import { render } from 'solid-js/web';
import { createComponent } from 'solid-js';
import { Annotator } from '@osdlabel/solid';
render(() => createComponent(Annotator, { images: [], contexts: [] }), document.body);`,
  },
  {
    name: 'element',
    what: '<osdlabel-annotator>, hand-rolled customElements.define wrapper (everything bundled)',
    source: `import { defineOsdlabelAnnotator } from '@osdlabel/element';
defineOsdlabelAnnotator();`,
  },
  {
    name: 'element-solid-element',
    what: 'the same element built with solid-element / component-register (everything bundled)',
    source: `import { defineWithSolidElement } from '@osdlabel/element/solid-element-variant';
defineWithSolidElement();`,
  },
  {
    name: 'react-binding',
    what: '@osdlabel/react <Annotator> mounted with react-dom/client (everything bundled)',
    source: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Annotator } from '@osdlabel/react';
createRoot(document.body).render(createElement(Annotator, { images: [], contexts: [] }));`,
  },
  {
    name: 'element-wrapper-only',
    what: 'hand-rolled wrapper alone: @osdlabel/*, osdlabel, solid-js, fabric, OSD external',
    external: SHARED_EXTERNALS,
    source: `import { defineOsdlabelAnnotator } from '@osdlabel/element';
defineOsdlabelAnnotator();`,
  },
  {
    name: 'solid-element-wrapper-only',
    what: 'solid-element wrapper alone (component-register bundled; the rest external)',
    external: SHARED_EXTERNALS,
    source: `import { defineWithSolidElement } from '@osdlabel/element/solid-element-variant';
defineWithSolidElement();`,
  },
  {
    name: 'solid-binding-own-code',
    what: 'solid-binding with fabric, openseadragon and solid-js external: osdlabel code only',
    external: ['fabric', 'openseadragon', /^solid-js(\/|$)/],
    source: `import { render } from 'solid-js/web';
import { createComponent } from 'solid-js';
import { Annotator } from '@osdlabel/solid';
render(() => createComponent(Annotator, { images: [], contexts: [] }), document.body);`,
  },
  {
    name: 'react-binding-own-code',
    what: 'react-binding with fabric, openseadragon, react and react-dom external (immer bundled)',
    external: ['fabric', 'openseadragon', 'react', /^react-dom(\/|$)/, /^react\//],
    source: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Annotator } from '@osdlabel/react';
createRoot(document.body).render(createElement(Annotator, { images: [], contexts: [] }));`,
  },
  {
    name: 'host-vanilla',
    what: 'vanilla host page (element + fixtures + probe)',
    entry: 'src/vanilla/main.ts',
  },
  { name: 'host-vue', what: 'Vue 3.5 host page (vue runtime + element)', entry: 'src/vue/main.ts' },
  {
    name: 'host-svelte',
    what: 'Svelte 5 host page (svelte runtime + element)',
    entry: 'src/svelte/main.ts',
  },
  {
    name: 'host-angular-jit',
    what: 'Angular 22 host page, JIT (includes @angular/compiler; AOT would be far smaller)',
    entry: 'src/angular/main.ts',
  },
  {
    name: 'host-react19',
    what: 'React 19 host page using the element (not @osdlabel/react)',
    entry: 'src/react-host/main.ts',
  },
];

function listOutputs(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(m?js|css)$/.test(d.name))
    .map((d) => path.join(d.parentPath ?? d.path, d.name));
}

async function measureSizes() {
  const entriesDir = path.join(WORK_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const out = [];
  for (const v of SIZE_VARIANTS) {
    let entry;
    if (v.source) {
      entry = path.join(entriesDir, `${v.name}.ts`);
      fs.writeFileSync(entry, v.source);
    } else {
      entry = path.join(APP_DIR, v.entry);
    }
    const outDir = path.join(WORK_DIR, 'sizes', v.name);
    await build({
      configFile: false,
      root: APP_DIR,
      logLevel: 'error',
      publicDir: false,
      plugins: [
        vue({
          template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('osdlabel-') } },
        }),
        svelte(),
      ],
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        target: 'es2022',
        modulePreload: false,
        copyPublicDir: false,
        reportCompressedSize: false,
        chunkSizeWarningLimit: 1e9,
        rollupOptions: {
          input: entry,
          ...(v.external ? { external: v.external } : {}),
          output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
        },
      },
    });
    const files = listOutputs(outDir);
    const total = Buffer.concat(files.map((f) => fs.readFileSync(f)));
    const perFile = files.map((f) => ({
      file: path.relative(outDir, f),
      ...compressedSizes(fs.readFileSync(f)),
    }));
    out.push({
      name: v.name,
      what: v.what,
      files: files.length,
      ...compressedSizes(total),
      perFile,
    });
    console.error(`  sizes: ${v.name} done`);
  }
  return out;
}

// ── tti ─────────────────────────────────────────────────────────────────────

const TTI_HOSTS = [
  { name: 'solid (binding, no element)', url: '/solid.html' },
  { name: 'vanilla (element, shadow)', url: '/vanilla.html' },
  { name: 'vanilla (element, light DOM)', url: '/lab.html?mode=light&css=none' },
  { name: 'vanilla (solid-element)', url: '/vanilla-se.html' },
  { name: 'vue', url: '/vue.html' },
  { name: 'svelte', url: '/svelte.html' },
  { name: 'angular (JIT)', url: '/angular.html' },
  { name: 'react 19 (element)', url: '/react-host.html' },
];

async function withPreviewServer(fn) {
  await build({
    root: APP_DIR,
    configFile: path.join(APP_DIR, 'vite.config.ts'),
    logLevel: 'error',
  });
  const server = await preview({
    root: APP_DIR,
    configFile: path.join(APP_DIR, 'vite.config.ts'),
    logLevel: 'error',
    preview: { port: PORT, strictPort: true },
  });
  try {
    return await fn(`http://localhost:${PORT}`);
  } finally {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}


async function sampleTti(browser, base, host) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(base + host.url);
    await page.waitForFunction(() => window.__interactive, null, { timeout: 30_000 });
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const data = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const js = performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js'));
      return {
        interactiveAt: window.__interactive.interactiveAt,
        frames: window.__interactive.frames,
        marks: window.__marks ?? {},
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
        jsDecodedBytes: js.reduce((a, r) => a + r.decodedBodySize, 0),
        crossOriginIsolated: window.crossOriginIsolated,
      };
    });
    return {
      ...data,
      scriptMs: m.ScriptDuration * 1000,
      layoutMs: m.LayoutDuration * 1000,
      recalcStyleMs: m.RecalcStyleDuration * 1000,
      taskMs: m.TaskDuration * 1000,
      jsHeapMiB: m.JSHeapUsedSize / 1048576,
    };
  } finally {
    await context.close();
  }
}

async function measureTti(browser, base) {
  const samples = Object.fromEntries(TTI_HOSTS.map((h) => [h.name, []]));
  // One untimed pass warms the OS file cache and the preview server.
  for (const h of TTI_HOSTS) await sampleTti(browser, base, h);
  for (let rep = 0; rep < REPS; rep++) {
    const order = TTI_HOSTS.map((_, i) => TTI_HOSTS[(i + rep) % TTI_HOSTS.length]);
    for (const h of order) samples[h.name].push(await sampleTti(browser, base, h));
    console.error(`  tti: rep ${rep + 1}/${REPS} done`);
  }
  return Object.fromEntries(
    Object.entries(samples).map(([name, xs]) => [
      name,
      {
        interactiveMs: summarize(xs.map((x) => x.interactiveAt)),
        elementReadyMs: summarize(xs.map((x) => x.marks['element-ready'] ?? Number.NaN)),
        domContentLoadedMs: summarize(xs.map((x) => x.domContentLoaded)),
        scriptMs: summarize(xs.map((x) => x.scriptMs)),
        layoutMs: summarize(xs.map((x) => x.layoutMs)),
        recalcStyleMs: summarize(xs.map((x) => x.recalcStyleMs)),
        taskMs: summarize(xs.map((x) => x.taskMs)),
        jsHeapMiB: summarize(xs.map((x) => x.jsHeapMiB)),
        jsDecodedKiB: summarize(xs.map((x) => x.jsDecodedBytes / 1024)),
        crossOriginIsolated: xs.every((x) => x.crossOriginIsolated),
        raw: xs,
      },
    ]),
  );
}

// ── css ─────────────────────────────────────────────────────────────────────

const STYLE_PROPS = [
  'font-family',
  'font-size',
  'line-height',
  'font-weight',
  'letter-spacing',
  'text-transform',
  'color',
  'background-color',
  'padding-top',
  'padding-left',
  'margin-top',
  'margin-left',
  'border-top-width',
  'border-top-style',
  'border-top-left-radius',
  'box-sizing',
  'display',
  'vertical-align',
  'width',
  'height',
];
const INHERITED = new Set([
  'font-family',
  'font-size',
  'line-height',
  'font-weight',
  'letter-spacing',
  'text-transform',
  'color',
]);

async function sampleCss(browser, base, mode, css) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/lab.html?mode=${mode}&css=${css}`);
    await page.waitForFunction(() => window.__interactive, null, { timeout: 30_000 });
    const snapshot = await page.evaluate((props) => {
      const lab = window.__lab;
      const root = lab.el.renderRoot.querySelector('[data-testid="annotator-root"]');
      const sig = [];
      const walk = (node, p) => {
        const cs = getComputedStyle(node);
        const values = {};
        for (const k of props) values[k] = cs.getPropertyValue(k);
        sig.push({ path: p, tag: node.tagName.toLowerCase(), props: values });
        [...node.children].forEach((c, i) => walk(c, `${p}/${i}`));
      };
      walk(root, '0');
      const bar = root.firstElementChild.getBoundingClientRect();
      const canvas = lab.el.renderRoot.querySelector('canvas.upper-canvas').getBoundingClientRect();
      return {
        sig,
        toolbarBarHeight: bar.height,
        canvasRect: { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
        headStyleNodes: document.head.querySelectorAll('style').length,
      };
    }, STYLE_PROPS);
    // Draw the same rectangle (fixed fractions of the canvas) and read its image-space geometry.
    await page.getByTestId('tool-rectangle').click();
    const c = snapshot.canvasRect;
    await page.mouse.move(c.x + c.w * 0.3, c.y + c.h * 0.3);
    await page.mouse.down();
    await page.mouse.move(c.x + c.w * 0.3 + 120, c.y + c.h * 0.3 + 80, { steps: 6 });
    await page.mouse.up();
    await page
      .waitForFunction(() => window.__lab.el.annotations.length === 1, null, {
        timeout: 5000,
      })
      .catch(() => undefined);
    const geometry = await page.evaluate(() => window.__lab.el.annotations[0]?.geometry ?? null);
    return { ...snapshot, geometry };
  } finally {
    await context.close();
  }
}

async function measureCss(browser, base) {
  const out = [];
  for (const mode of ['shadow', 'light']) {
    const baseline = await sampleCss(browser, base, mode, 'none');
    for (const css of ['none', 'bootstrap', 'tailwind']) {
      const s = css === 'none' ? baseline : await sampleCss(browser, base, mode, css);
      const diff = diffStyleSignatures(baseline.sig, s.sig);
      const inheritedOnly = Object.keys(diff.propertyCounts).every((k) => INHERITED.has(k));
      const g0 = baseline.geometry;
      const g1 = s.geometry;
      const geometryDelta =
        g0 && g1 && g0.type === 'rectangle' && g1.type === 'rectangle'
          ? Math.max(
              Math.abs(g0.origin.x - g1.origin.x),
              Math.abs(g0.origin.y - g1.origin.y),
              Math.abs(g0.width - g1.width),
              Math.abs(g0.height - g1.height),
            )
          : null;
      out.push({
        mode,
        css,
        elements: diff.compared,
        elementsDiffering: diff.elementsDiffering,
        missingElements: diff.missing,
        propertyCounts: diff.propertyCounts,
        onlyInheritedPropertiesDiffer: inheritedOnly,
        toolbarBarHeight: s.toolbarBarHeight,
        toolbarBarHeightBaseline: baseline.toolbarBarHeight,
        rectangleCreated: g1 !== null,
        geometryMaxAbsDeltaImagePx: geometryDelta,
      });
      console.error(`  css: ${mode}/${css} done`);
    }
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR }).toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const result = {
    meta: {
      startedAt: new Date().toISOString(),
      gitSha: gitSha(),
      node: process.version,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? null,
      totalMemGiB: +(os.totalmem() / 1073741824).toFixed(1),
      loadAvg1mAtStart: os.loadavg()[0],
      reps: REPS,
      chromium: EXECUTABLE ?? 'playwright-bundled',
    },
  };

  if (ONLY.has('sizes')) {
    console.error('measuring bundle sizes…');
    result.sizes = await measureSizes();
  }

  if (ONLY.has('tti') || ONLY.has('css')) {
    const browser = await chromium.launch({
      ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
    });
    try {
      result.meta.browserVersion = browser.version();
      await withPreviewServer(async (base) => {
        if (ONLY.has('tti')) {
          console.error(`measuring time to first interactive cell (${REPS} reps)…`);
          result.tti = await measureTti(browser, base);
        }
        if (ONLY.has('css')) {
          console.error('measuring CSS isolation…');
          result.css = await measureCss(browser, base);
        }
      });
    } finally {
      await browser.close();
    }
  }
  result.meta.finishedAt = new Date().toISOString();
  result.meta.loadAvg1mAtEnd = os.loadavg()[0];

  const stamp = result.meta.startedAt.replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `bench-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(result, null, 2));

  if (result.sizes) {
    const solid = result.sizes.find((s) => s.name === 'solid-binding');
    console.log('\nBundle sizes (KiB; Vite 8 production build, all emitted JS/CSS)');
    console.log(
      table(
        ['variant', 'raw', 'gzip', 'brotli', 'gzip vs solid-binding'],
        result.sizes.map((s) => [
          s.name,
          kib(s.raw),
          kib(s.gzip),
          kib(s.brotli),
          solid ? `${s.gzip - solid.gzip >= 0 ? '+' : ''}${kib(s.gzip - solid.gzip)}` : '',
        ]),
      ),
    );
  }
  if (result.tti) {
    console.log(
      `\nTime to first interactive cell (ms since navigation start; ${REPS} reps, cold cache)`,
    );
    console.log(
      table(
        [
          'host',
          'median',
          'p25',
          'p75',
          'element-ready med',
          'script ms med',
          'task ms med',
          'heap MiB med',
        ],
        Object.entries(result.tti).map(([name, t]) => [
          name,
          t.interactiveMs.median.toFixed(0),
          t.interactiveMs.p25.toFixed(0),
          t.interactiveMs.p75.toFixed(0),
          t.elementReadyMs.median.toFixed(0),
          t.scriptMs.median.toFixed(0),
          t.taskMs.median.toFixed(0),
          t.jsHeapMiB.median.toFixed(1),
        ]),
      ),
    );
  }
  if (result.css) {
    console.log(
      '\nCSS isolation (annotator subtree computed styles vs the same mode without host CSS)',
    );
    console.log(
      table(
        [
          'mode',
          'host css',
          'elements',
          'differing',
          'inherited-only',
          'bar h',
          'rect drawn',
          'geom Δ px',
        ],
        result.css.map((c) => [
          c.mode,
          c.css,
          c.elements,
          c.elementsDiffering,
          c.onlyInheritedPropertiesDiffer ? 'yes' : 'no',
          `${c.toolbarBarHeight.toFixed(0)} (${c.toolbarBarHeightBaseline.toFixed(0)})`,
          c.rectangleCreated ? 'yes' : 'NO',
          c.geometryMaxAbsDeltaImagePx === null ? '-' : c.geometryMaxAbsDeltaImagePx.toFixed(2),
        ]),
      ),
    );
  }
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
}

await main();
