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
 *         preflight (unlayered, and inside `@layer base` as Tailwind 4 ships
 *         it), in shadow and light DOM, the latter with the stock toolbar
 *         sheet layered or unlayered; computed styles of every element in the
 *         annotator vs the same mode without host CSS, which of the toolbar's
 *         stock-set properties host CSS overrode, plus whether a drawn
 *         rectangle's image-space geometry changes.
 *  mount  UI mount microbenchmark (no image, so no OSD/WebGL): Solid and React
 *         bindings vs the element in shadow and light DOM, plus the stock
 *         stylesheet's construction and adoption costs. Not in the default
 *         set; add it with --only sizes,tti,css,mount.
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
  { name: 'lab (element, shadow DOM)', url: '/lab.html?mode=shadow&css=none' },
  { name: 'lab (element, light DOM)', url: '/lab.html?mode=light&css=none' },
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

/**
 * The properties the stock toolbar sets on its own elements (inline before the
 * stylesheet prototype, in `@layer osdlabel` after). A host rule changing one
 * of these on a toolbar element is the stock style losing to host CSS.
 */
const TOOLBAR_STOCK_PROPS = [
  'padding-top',
  'padding-left',
  'border-top-style',
  'border-top-left-radius',
  'cursor',
  'background-color',
  'color',
  'font-weight',
  'font-size',
  'opacity',
  'display',
  'column-gap',
  'align-items',
  'flex-wrap',
  'white-space',
  'min-width',
];

async function sampleCss(browser, base, mode, css, stock) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/lab.html?mode=${mode}&css=${css}${stock ? `&stock=${stock}` : ''}`);
    await page.waitForFunction(() => window.__interactive, null, { timeout: 30_000 });
    const snapshot = await page.evaluate(
      ([props, toolbarProps]) => {
        const lab = window.__lab;
        const renderRoot = lab.el.renderRoot;
        const root = renderRoot.querySelector('[data-testid="annotator-root"]');
        const sig = [];
        const walk = (node, p) => {
          const cs = getComputedStyle(node);
          const values = {};
          for (const k of props) values[k] = cs.getPropertyValue(k);
          sig.push({ path: p, tag: node.tagName.toLowerCase(), props: values });
          [...node.children].forEach((c, i) => walk(c, `${p}/${i}`));
        };
        walk(root, '0');
        const toolbarSig = [];
        const toolbar = renderRoot.querySelector('[part~="toolbar"]');
        const walkToolbar = (node, p) => {
          const cs = getComputedStyle(node);
          const values = {};
          for (const k of toolbarProps) values[k] = cs.getPropertyValue(k);
          toolbarSig.push({ path: p, tag: node.tagName.toLowerCase(), props: values });
          [...node.children].forEach((c, i) => walkToolbar(c, `${p}/${i}`));
        };
        if (toolbar) walkToolbar(toolbar, 't');
        const rectButton = renderRoot.querySelector('[data-testid="tool-rectangle"]');
        const rb = rectButton ? rectButton.getBoundingClientRect() : null;
        const bar = root.firstElementChild.getBoundingClientRect();
        const canvas = renderRoot.querySelector('canvas.upper-canvas').getBoundingClientRect();
        return {
          sig,
          toolbarSig,
          rectButtonBox: rb ? { w: rb.width, h: rb.height } : null,
          toolbarBarHeight: bar.height,
          canvasRect: { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
          headStyleNodesAdded: lab.headNodesAfter() - lab.headNodesBefore,
          documentAdoptedSheets: document.adoptedStyleSheets.length,
          shadowAdoptedSheets: lab.el.shadowRoot
            ? lab.el.shadowRoot.adoptedStyleSheets.length
            : null,
          shadowStyleNodes: lab.el.shadowRoot
            ? lab.el.shadowRoot.querySelectorAll('style').length
            : null,
        };
      },
      [STYLE_PROPS, TOOLBAR_STOCK_PROPS],
    );
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
    // Where the committed shape is on screen, through the overlay's own
    // image->screen mapping: compared with where the pointer went, this is
    // the hit-testing error, independent of any layout shift.
    const drawn = await page.evaluate(() => {
      const el = window.__lab.el;
      const g = el.annotations[0]?.geometry ?? null;
      if (!g || g.type !== 'rectangle') return { geometry: g, screen: null };
      const osd = el.renderRoot.querySelector('.openseadragon-canvas');
      // OSD viewer-element coordinates are relative to the viewer container
      // (`viewer.container`), the parent of the OSD canvas.
      const r = osd.__osdViewer.container.getBoundingClientRect();
      const p0 = osd.__osdOverlay.imageToScreen(g.origin);
      const p1 = osd.__osdOverlay.imageToScreen({
        x: g.origin.x + g.width,
        y: g.origin.y + g.height,
      });
      return {
        geometry: g,
        screen: { x0: r.left + p0.x, y0: r.top + p0.y, x1: r.left + p1.x, y1: r.top + p1.y },
      };
    });
    const pointer = {
      x0: c.x + c.w * 0.3,
      y0: c.y + c.h * 0.3,
      x1: c.x + c.w * 0.3 + 120,
      y1: c.y + c.h * 0.3 + 80,
    };
    const pointerErrorPx = drawn.screen
      ? Math.max(
          Math.abs(drawn.screen.x0 - pointer.x0),
          Math.abs(drawn.screen.y0 - pointer.y0),
          Math.abs(drawn.screen.x1 - pointer.x1),
          Math.abs(drawn.screen.y1 - pointer.y1),
        )
      : null;
    return { ...snapshot, geometry: drawn.geometry, pointerErrorPx };
  } finally {
    await context.close();
  }
}

/**
 * Light-DOM stock-style variants (`lab.html?stock=`): `layer` is the shipped
 * `@layer osdlabel` sheet; `unlayered` additionally adopts the same rules
 * without the layer into the document, emulating an unlayered class-selector
 * sheet. Shadow DOM is measured once: host CSS cannot reach the sheet there.
 * `--stock-variants none` measures a checkout without the stylesheet.
 */
const STOCK_VARIANTS = String(arg('--stock-variants', 'layer,unlayered'))
  .split(',')
  .filter((v) => v && v !== 'none');
const CSS_CONDITIONS = ['none', 'bootstrap', 'tailwind', 'tailwind-layered'];

async function measureCss(browser, base) {
  const out = [];
  const runs = [{ mode: 'shadow', stock: null }];
  if (STOCK_VARIANTS.length === 0) runs.push({ mode: 'light', stock: null });
  for (const stock of STOCK_VARIANTS) runs.push({ mode: 'light', stock });
  for (const { mode, stock } of runs) {
    const baseline = await sampleCss(browser, base, mode, 'none', stock);
    for (const css of CSS_CONDITIONS) {
      const s = css === 'none' ? baseline : await sampleCss(browser, base, mode, css, stock);
      const diff = diffStyleSignatures(baseline.sig, s.sig);
      const toolbarDiff = diffStyleSignatures(baseline.toolbarSig, s.toolbarSig);
      const inheritedOnly = Object.keys(diff.propertyCounts).every((k) => INHERITED.has(k));
      // Neither inherited nor a layout consequence (width/height): only a
      // host rule whose selector matched the element can change these.
      const selectorMatched = Object.keys(diff.propertyCounts).filter(
        (k) => !INHERITED.has(k) && k !== 'width' && k !== 'height',
      );
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
        stock: stock ?? 'default',
        css,
        toolbarElements: toolbarDiff.compared,
        toolbarStockPropsChanged: Object.values(toolbarDiff.propertyCounts).reduce(
          (a, b) => a + b,
          0,
        ),
        toolbarStockPropertyCounts: toolbarDiff.propertyCounts,
        rectButtonBox: s.rectButtonBox,
        rectButtonBoxBaseline: baseline.rectButtonBox,
        headStyleNodesAdded: s.headStyleNodesAdded,
        documentAdoptedSheets: s.documentAdoptedSheets,
        shadowAdoptedSheets: s.shadowAdoptedSheets,
        shadowStyleNodes: s.shadowStyleNodes,
        elements: diff.compared,
        elementsDiffering: diff.elementsDiffering,
        missingElements: diff.missing,
        propertyCounts: diff.propertyCounts,
        onlyInheritedPropertiesDiffer: inheritedOnly,
        selectorMatchedProperties: selectorMatched,
        toolbarBarHeight: s.toolbarBarHeight,
        toolbarBarHeightBaseline: baseline.toolbarBarHeight,
        rectangleCreated: g1 !== null,
        pointerToShapeErrorScreenPx: s.pointerErrorPx,
        geometryMaxAbsDeltaImagePx: geometryDelta,
      });
      console.error(`  css: ${mode}${stock ? `/${stock}` : ''}/${css} done`);
    }
  }
  return out;
}

// ── mount ───────────────────────────────────────────────────────────────────

/**
 * Mount microbenchmark (mount-bench.html): the UI mount alone, no image, so
 * no OSD viewer or WebGL; plus the stock stylesheet's construction and
 * adoption costs. One fresh browser context per page load; `--mount-pages`
 * loads per variant, variants rotated each load.
 */
const MOUNT_VARIANTS = ['solid', 'react', 'element-shadow', 'element-light'];
const MOUNT_PAGES = Number(arg('--mount-pages', '5'));
const MOUNT_REPS = Number(arg('--mount-reps', '40'));

async function sampleMount(browser, base, variant) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/mount-bench.html?variant=${variant}&reps=${MOUNT_REPS}`);
    await page.waitForFunction(() => window.__mountBench, null, { timeout: 120_000 });
    return await page.evaluate(() => window.__mountBench);
  } finally {
    await context.close();
  }
}

async function measureMount(browser, base) {
  const samples = Object.fromEntries(MOUNT_VARIANTS.map((v) => [v, []]));
  for (const v of MOUNT_VARIANTS) await sampleMount(browser, base, v); // warm-up pass
  for (let p = 0; p < MOUNT_PAGES; p++) {
    const order = MOUNT_VARIANTS.map((_, i) => MOUNT_VARIANTS[(i + p) % MOUNT_VARIANTS.length]);
    for (const v of order) samples[v].push(await sampleMount(browser, base, v));
    console.error(`  mount: page ${p + 1}/${MOUNT_PAGES} done`);
  }
  return Object.fromEntries(
    Object.entries(samples).map(([v, xs]) => [
      v,
      {
        firstMountMs: summarize(xs.map((x) => x.firstMountMs)),
        mountMs: summarize(xs.flatMap((x) => x.mountMs)),
        mountStyleLayoutMs: summarize(xs.flatMap((x) => x.mountStyleLayoutMs)),
        sheetConstructUs: summarize(xs.flatMap((x) => x.sheetConstructUs)),
        adoptStockUs: summarize(xs.flatMap((x) => x.adoptStockUs)),
        adoptEmptyUs: summarize(xs.flatMap((x) => x.adoptEmptyUs)),
        toolbarButtons: xs[0]?.toolbarButtons ?? null,
        crossOriginIsolated: xs.every((x) => x.crossOriginIsolated),
        pages: xs.length,
        repsPerPage: MOUNT_REPS,
      },
    ]),
  );
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

  if (ONLY.has('tti') || ONLY.has('css') || ONLY.has('mount')) {
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
        if (ONLY.has('mount')) {
          console.error(
            `measuring mounts (${MOUNT_PAGES} pages × ${MOUNT_REPS} reps per variant)…`,
          );
          result.mount = await measureMount(browser, base);
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
          'stock css',
          'host css',
          'elements',
          'differing',
          'props via selectors',
          'toolbar stock props lost',
          'rect btn w×h (base)',
          'head <style> +',
          'adopted doc/shadow',
          'bar h (base)',
          'rect drawn',
          'pointer err px',
          'geom Δ img px',
        ],
        result.css.map((c) => [
          c.mode,
          c.stock,
          c.css,
          c.elements,
          c.elementsDiffering,
          c.selectorMatchedProperties.join(',') || 'none',
          `${c.toolbarStockPropsChanged}${
            c.toolbarStockPropsChanged
              ? ` (${Object.entries(c.toolbarStockPropertyCounts)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(', ')})`
              : ''
          }`,
          c.rectButtonBox
            ? `${c.rectButtonBox.w.toFixed(0)}×${c.rectButtonBox.h.toFixed(0)} (${c.rectButtonBoxBaseline.w.toFixed(0)}×${c.rectButtonBoxBaseline.h.toFixed(0)})`
            : '-',
          c.headStyleNodesAdded,
          `${c.documentAdoptedSheets}/${c.shadowAdoptedSheets ?? '-'}`,
          `${c.toolbarBarHeight.toFixed(0)} (${c.toolbarBarHeightBaseline.toFixed(0)})`,
          c.rectangleCreated ? 'yes' : 'NO',
          c.pointerToShapeErrorScreenPx === null ? '-' : c.pointerToShapeErrorScreenPx.toFixed(2),
          c.geometryMaxAbsDeltaImagePx === null ? '-' : c.geometryMaxAbsDeltaImagePx.toFixed(2),
        ]),
      ),
    );
  }
  if (result.mount) {
    console.log(
      `\nUI mount, no image (ms; ${MOUNT_PAGES} page loads × ${MOUNT_REPS} reps), and stock-stylesheet costs (µs)`,
    );
    console.log(
      table(
        [
          'variant',
          'mount med',
          'p25',
          'p75',
          '+style/layout med',
          'first mount med',
          'sheet construct µs',
          'adopt+recalc stock µs',
          'adopt+recalc empty µs',
        ],
        Object.entries(result.mount).map(([v, m]) => [
          v,
          m.mountMs.median.toFixed(2),
          m.mountMs.p25.toFixed(2),
          m.mountMs.p75.toFixed(2),
          m.mountStyleLayoutMs.median.toFixed(2),
          m.firstMountMs.median.toFixed(1),
          m.sheetConstructUs.median.toFixed(1),
          m.adoptStockUs.median.toFixed(0),
          m.adoptEmptyUs.median.toFixed(0),
        ]),
      ),
    );
  }
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
}

await main();
