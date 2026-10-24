/**
 * Mount microbenchmark (review: TTI cannot resolve the element's own mount
 * cost, being dominated by image load and SwiftShader work).
 *
 *   mount-bench.html?variant=solid|react|element-shadow|element-light&reps=40
 *
 * Mounts and unmounts the annotator `reps` times (after `warmup`), with no
 * image assigned, so no OSD viewer or WebGL context is created: what is timed
 * is the UI mount itself (toolbar, filmstrip, grid placeholder, status bar,
 * view controls), synchronously, then with a forced style + layout.
 *
 * It also times the stock stylesheet's own costs in isolation:
 * - constructing and parsing it (`new CSSStyleSheet()` + `replaceSync`);
 * - adopting it into the mounted annotator's root and forcing a style recalc
 *   of the toolbar, against adopting an empty sheet the same way.
 */
import { OSDLABEL_STOCK_CSS } from 'osdlabel';

type Variant = 'solid' | 'react' | 'element-shadow' | 'element-light';
const VARIANTS: readonly Variant[] = ['solid', 'react', 'element-shadow', 'element-light'];

export interface MountBenchResult {
  readonly variant: Variant;
  readonly crossOriginIsolated: boolean;
  /** The page's first mount: pays the stock sheet's construction and first adoption. */
  readonly firstMountMs: number;
  readonly mountMs: readonly number[];
  readonly mountStyleLayoutMs: readonly number[];
  /** Per sheet, from batches of 50. */
  readonly sheetConstructUs: readonly number[];
  /** Adopt the stock sheet + recalc the toolbar, minus the same with an empty sheet. */
  readonly adoptStockUs: readonly number[];
  readonly adoptEmptyUs: readonly number[];
  readonly toolbarButtons: number;
}

const params = new URLSearchParams(location.search);
const variant: Variant = VARIANTS.find((v) => v === params.get('variant')) ?? 'solid';
const reps = Number(params.get('reps') ?? '40');
const warmup = Number(params.get('warmup') ?? '5');

interface Mounted {
  readonly host: HTMLElement;
  readonly renderRoot: Document | ShadowRoot;
  readonly unmount: () => Promise<void>;
}

async function mountOnce(container: HTMLElement): Promise<Mounted> {
  switch (variant) {
    case 'solid': {
      const { mountSolid } = await import('../solid/mount-bench-solid.js');
      const dispose = mountSolid(container);
      return {
        host: container,
        renderRoot: document,
        unmount: async () => dispose(),
      };
    }
    case 'react': {
      const { mountReact } = await import('./react-mount.js');
      const unmount = mountReact(container);
      return { host: container, renderRoot: document, unmount: async () => unmount() };
    }
    case 'element-shadow':
    case 'element-light': {
      const { mountElementSync } = await import('./element-mount.js');
      const el = mountElementSync(container, variant === 'element-shadow' ? 'open' : 'none');
      return {
        host: el,
        renderRoot: el.shadowRoot ?? document,
        unmount: async () => {
          el.remove();
          // Teardown is deferred to a microtask (a move is not an unmount).
          await Promise.resolve();
          await Promise.resolve();
        },
      };
    }
  }
}

/** Preloads the variant's module, so the first timed mount does not include the import. */
async function preload(): Promise<void> {
  if (variant === 'solid') await import('../solid/mount-bench-solid.js');
  else if (variant === 'react') await import('./react-mount.js');
  else await import('./element-mount.js');
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function timeMount(): Promise<{ mount: number; styleLayout: number }> {
  const container = document.createElement('div');
  container.style.cssText = 'width:900px;height:560px';
  document.body.append(container);
  const t0 = performance.now();
  const mounted = await mountOnce(container);
  const t1 = performance.now();
  void container.offsetHeight;
  const t2 = performance.now();
  await mounted.unmount();
  container.remove();
  await nextTask();
  return { mount: t1 - t0, styleLayout: t2 - t0 };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function sheetConstructSamples(): number[] {
  const out: number[] = [];
  for (let batch = 0; batch < 20; batch++) {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) new CSSStyleSheet().replaceSync(OSDLABEL_STOCK_CSS);
    out.push(((performance.now() - t0) / 50) * 1000);
  }
  return out;
}

/** Adopt a fresh copy of `css` into `root`, force the toolbar's style, then remove it again. */
function adoptSamples(root: Document | ShadowRoot, css: string, buttons: Element[]): number[] {
  const out: number[] = [];
  const base = root.adoptedStyleSheets;
  for (let i = 0; i < 60; i++) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const t0 = performance.now();
    root.adoptedStyleSheets = [...base, sheet];
    for (const b of buttons) void getComputedStyle(b).backgroundColor;
    out.push((performance.now() - t0) * 1000);
    root.adoptedStyleSheets = base;
    for (const b of buttons) void getComputedStyle(b).backgroundColor;
  }
  return out;
}

async function run(): Promise<MountBenchResult> {
  await preload();
  const first = await timeMount();
  for (let i = 0; i < warmup; i++) await timeMount();
  const mountMs: number[] = [];
  const mountStyleLayoutMs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const r = await timeMount();
    mountMs.push(r.mount);
    mountStyleLayoutMs.push(r.styleLayout);
  }

  // Stylesheet costs, on a mounted annotator.
  const container = document.createElement('div');
  container.style.cssText = 'width:900px;height:560px';
  document.body.append(container);
  const mounted = await mountOnce(container);
  const buttons = [...mounted.renderRoot.querySelectorAll('[part~="tool-button"]')];
  const sheetConstructUs = sheetConstructSamples();
  const adoptStockUs = adoptSamples(mounted.renderRoot, OSDLABEL_STOCK_CSS, buttons);
  const adoptEmptyUs = adoptSamples(mounted.renderRoot, '', buttons);

  return {
    variant,
    crossOriginIsolated: window.crossOriginIsolated,
    firstMountMs: first.mount,
    mountMs,
    mountStyleLayoutMs,
    sheetConstructUs,
    adoptStockUs,
    adoptEmptyUs,
    toolbarButtons: buttons.length,
  };
}

const result = await run();
(window as unknown as { __mountBench: MountBenchResult }).__mountBench = result;
document.getElementById('summary')!.textContent =
  `${variant}: first ${result.firstMountMs.toFixed(1)} ms, median ${median(result.mountMs).toFixed(2)} ms ` +
  `(+style/layout ${median(result.mountStyleLayoutMs).toFixed(2)} ms), sheet construct ` +
  `${median(result.sheetConstructUs).toFixed(1)} µs, adopt stock ${median(result.adoptStockUs).toFixed(0)} µs ` +
  `vs empty ${median(result.adoptEmptyUs).toFixed(0)} µs`;
