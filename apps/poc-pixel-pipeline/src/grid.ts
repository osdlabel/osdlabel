import OpenSeadragon from 'openseadragon';
import { Rect } from 'fabric';
import { DecorationLayer, FabricOverlay } from '@osdlabel/fabric-osd';
import { DEFAULT_VIEWER_OPTIONS } from '@osdlabel/osd-helper';
import { VoiWebGLDrawer } from '@osdlabel/osd-pixel';
import type { VoiWebGLDrawer as VoiDrawerType } from '@osdlabel/osd-pixel';
import { drawerType, frames, rafLoop, summarize } from './common.js';

/**
 * H4: a grid of osdlabel-like cells (OSD viewer with osdlabel's default
 * options + FabricOverlay + DecorationLayer, as ViewerCell builds them), to
 * count WebGL contexts and watch what happens past Chrome's limit.
 *
 * Fabric is imported here only to put one red rectangle on each overlay, so a
 * screenshot shows whether annotations are still drawn above the image.
 */

export type GridMode = 'stock-default' | 'stock-canvas' | 'voi-own' | 'voi-shared' | 'voi-page';

interface Cell {
  readonly index: number;
  readonly el: HTMLElement;
  readonly viewer: OpenSeadragon.Viewer;
  overlay: FabricOverlay | null;
  layer: DecorationLayer | null;
  drawMs: number[];
  destroyed: boolean;
}

const PAGE_W = 1280;
const PAGE_H = 960;
const DZI = `/@fs${__REPO_ROOT__}/apps/dev/sample-data/tiled.dzi`;

declare const __REPO_ROOT__: string;

let cells: Cell[] = [];
let foreign: { canvas: HTMLCanvasElement; stop: () => void } | null = null;

function drawerOption(mode: GridMode): Partial<OpenSeadragon.Options> {
  switch (mode) {
    case 'stock-default':
      return {}; // osdlabel today: OSD's default ['webgl', 'canvas', 'html']
    case 'stock-canvas':
      return { drawer: 'canvas' };
    case 'voi-own':
    case 'voi-shared':
    case 'voi-page': {
      const target = mode === 'voi-own' ? 'own' : mode === 'voi-shared' ? 'shared' : 'page';
      return {
        drawer: VoiWebGLDrawer as unknown as OpenSeadragon.DrawerConstructor,
        drawerOptions: { custom: { target } } as unknown as NonNullable<
          OpenSeadragon.Options['drawerOptions']
        >,
      };
    }
  }
}

/** Wrap the drawer's draw() to time it (re-wrapped after a drawer swap). */
function instrument(cell: Cell): void {
  const d = cell.viewer.drawer as unknown as {
    draw: (items: unknown[]) => void;
    __timed?: boolean;
  };
  if (!d || d.__timed) return;
  const orig = d.draw.bind(d);
  d.draw = (items: unknown[]): void => {
    const t0 = performance.now();
    orig(items);
    cell.drawMs.push(performance.now() - t0);
  };
  d.__timed = true;
}

const live = (): Cell[] => cells.filter((c) => !c.destroyed);

function layout(n: number): { cols: number; rows: number; w: number; h: number } {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows, w: Math.floor(PAGE_W / cols), h: Math.floor(PAGE_H / rows) };
}

async function build(n: number, mode: GridMode): Promise<object> {
  destroyAll();
  const root = document.getElementById('grid')!;
  const { cols, w, h } = layout(n);
  const opened: Promise<void>[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'cell';
    Object.assign(el.style, {
      left: `${(i % cols) * w}px`,
      top: `${Math.floor(i / cols) * h}px`,
      width: `${w - 2}px`,
      height: `${h - 2}px`,
    });
    root.appendChild(el);
    const viewer = OpenSeadragon({
      ...DEFAULT_VIEWER_OPTIONS,
      element: el,
      immediateRender: true,
      ...drawerOption(mode),
    });
    const cell: Cell = {
      index: i,
      el,
      viewer,
      overlay: null,
      layer: null,
      drawMs: [],
      destroyed: false,
    };
    cells.push(cell);
    opened.push(
      new Promise((resolve, reject) => {
        viewer.addOnceHandler('open', () => {
          cell.overlay = new FabricOverlay(viewer);
          cell.layer = new DecorationLayer(cell.overlay);
          const rect = new Rect({
            left: 300,
            top: 200,
            width: 200,
            height: 150,
            fill: 'rgba(255,0,0,1)',
            selectable: false,
          });
          cell.overlay.canvas.add(rect);
          cell.overlay.canvas.requestRenderAll();
          instrument(cell);
          resolve();
        });
        viewer.addOnceHandler('open-failed', () => reject(new Error('open failed')));
      }),
    );
    viewer.open(DZI);
  }
  await Promise.all(opened);
  await frames(30);
  return {
    n,
    mode,
    buildMs: performance.now() - t0,
    drawerTypes: [...new Set(cells.map((c) => drawerType(c.viewer)))],
    contexts: probeSummary(),
  };
}

function probeSummary(): object {
  const p = (window as unknown as { __ctxProbe?: { summary(): object } }).__ctxProbe;
  return p ? p.summary() : { created: -1 };
}

/** Zoom every cell a little so each one redraws (what any interaction does). */
async function redrawAll(): Promise<void> {
  for (const c of live()) {
    c.viewer.viewport.zoomBy(1.02, undefined, true);
    c.viewer.forceRedraw();
  }
  await frames(10);
}

function cellRects(): { x: number; y: number; w: number; h: number }[] {
  return cells.map((c) => {
    const r = c.el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}

/**
 * Per-cell statistics of a page screenshot: is the image there (grey
 * variance), is the red annotation rectangle there (red pixels).
 */
async function analyzeScreenshot(pngBase64: string): Promise<object[]> {
  const bin = atob(pngBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  return cellRects().map((r, index) => {
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    let red = 0;
    for (let y = r.y + 2; y < r.y + r.h - 2; y += 2) {
      for (let x = r.x + 2; x < r.x + r.w - 2; x += 2) {
        const o = (y * bmp.width + x) * 4;
        const R = px[o]!;
        const G = px[o + 1]!;
        const B = px[o + 2]!;
        if (R > 200 && G < 60 && B < 60) {
          red++;
          continue;
        }
        const l = (R + G + B) / 3;
        sum += l;
        sum2 += l * l;
        n++;
      }
    }
    const mean = n ? sum / n : 0;
    const sd = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
    return { index, mean, sd, imageVisible: sd > 8, redPixels: red };
  });
}

/** Pan every cell one step per frame for `ms`; frame intervals and draw() times. */
async function panAll(ms: number): Promise<object> {
  for (const c of cells) c.drawMs = [];
  let k = 0;
  const intervals = await rafLoop(ms, () => {
    const dx = (k++ % 40 < 20 ? 1 : -1) * 0.004;
    for (const c of live()) c.viewer.viewport.panBy(new OpenSeadragon.Point(dx, 0), true);
  });
  const allDraws = cells.flatMap((c) => c.drawMs);
  const perFrameDrawTotal = intervals.length
    ? cells.reduce((a, c) => a + c.drawMs.reduce((x, y) => x + y, 0), 0) / intervals.length
    : 0;
  return {
    frame: summarize(intervals),
    fps: intervals.length ? 1000 / summarize(intervals).mean : 0,
    drawPerCell: summarize(allDraws),
    drawSumPerFrameMs: perFrameDrawTotal,
  };
}

/** A competing WebGL user: a 3D view, a SAM WebGL backend, a chart. */
function addForeign(): object {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  Object.assign(canvas.style, { position: 'fixed', right: '0', bottom: '0', zIndex: '10' });
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl2');
  let running = true;
  const tick = (t: number): void => {
    if (!running || !gl) return;
    gl.clearColor(0, (t / 1000) % 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  foreign = {
    canvas,
    stop: () => {
      running = false;
    },
  };
  return { created: !!gl };
}

/**
 * Mitigation (i): swap non-active cells to the CanvasDrawer at runtime.
 *
 * `raw` calls OSD's `viewer.requestDrawer` directly; `overlay` goes through
 * `FabricOverlay.replaceDrawer`, the fix this PoC adds to fabric-osd. A tone
 * filter is set on every cell first, to see whether it survives the swap.
 */
async function swapDrawers(
  to: 'canvas' | 'webgl',
  fromIndex: number,
  via: 'raw' | 'overlay',
): Promise<object> {
  for (const c of live())
    c.overlay?.applyImageFilters({ exposure: 0.2, contrast: 0.1, inverted: false });
  const times: number[] = [];
  const order: { drawerAboveFabric: boolean | null; drawerTop: number; filterKept: boolean }[] = [];
  for (const c of cells.slice(fromIndex)) {
    const t0 = performance.now();
    if (via === 'overlay' && c.overlay) c.overlay.replaceDrawer(to);
    else (c.viewer as unknown as { requestDrawer(d: string): unknown }).requestDrawer(to);
    times.push(performance.now() - t0);
    instrument(c);
    const children = [...c.viewer.canvas.children];
    const drawerCanvas = (c.viewer.drawer as unknown as { canvas: HTMLElement }).canvas;
    const fabricContainer = c.overlay?.canvas.getSelectionElement().parentElement ?? null;
    order.push({
      drawerAboveFabric: fabricContainer
        ? children.indexOf(drawerCanvas) > children.indexOf(fabricContainer)
        : null,
      drawerTop: Math.round(
        drawerCanvas.getBoundingClientRect().top - c.el.getBoundingClientRect().top,
      ),
      filterKept: drawerCanvas.style.filter !== '',
    });
  }
  await frames(10);
  return {
    to,
    via,
    swapped: order.length,
    swapMs: summarize(times),
    drawerCanvasAboveOverlay: order.filter((o) => o.drawerAboveFabric).length,
    drawerCanvasDisplaced: order.filter((o) => o.drawerTop !== 0).length,
    filterKept: order.filter((o) => o.filterKept).length,
    sample: order[0] ?? null,
    contexts: probeSummary(),
  };
}

async function destroyRange(from: number, to: number): Promise<object> {
  for (const c of cells.slice(from, to)) {
    c.layer?.destroy();
    c.overlay?.destroy();
    c.viewer.destroy();
    c.destroyed = true;
    c.el.style.visibility = 'hidden';
  }
  await frames(30);
  return probeSummary();
}

function destroyAll(): void {
  for (const c of live()) {
    c.layer?.destroy();
    c.overlay?.destroy();
    c.viewer.destroy();
  }
  for (const c of cells) c.el.remove();
  cells = [];
  foreign?.stop();
  foreign?.canvas.remove();
  foreign = null;
}

function voiTargetStats(): object[] {
  return cells.map((c) => {
    const d = c.viewer.drawer as unknown as VoiDrawerType | null;
    return d && 'targetStats' in d
      ? { index: c.index, ...d.targetStats, ...d.stats }
      : { index: c.index };
  });
}

/** Diagnostics for one cell: drawer, tiles, and what its canvas holds after a draw. */
function inspect(i: number): object {
  const c = cells[i];
  if (!c) return { error: 'no cell' };
  const item = c.viewer.world.getItemAt(0) as unknown as
    | { getTilesToDraw(): unknown[] }
    | undefined;
  const tiles = item?.getTilesToDraw().length ?? -1;
  c.viewer.world.draw();
  const canvas = (c.viewer.drawer as unknown as { canvas: HTMLCanvasElement }).canvas;
  const ctx = canvas.getContext('2d');
  const centre = ctx ? [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] : null;
  return { drawer: drawerType(c.viewer), tiles, canvas: [canvas.width, canvas.height], centre };
}

/**
 * Is cell `i`'s viewer still alive? Pans it and counts `update-viewport`
 * events for 400 ms. OSD 5 runs its update loop from `requestAnimationFrame`;
 * an exception thrown by the drawer inside that loop stops it rescheduling.
 */
async function liveness(i: number): Promise<{ updates: number }> {
  const c = cells[i];
  if (!c || c.destroyed) return { updates: -1 };
  let updates = 0;
  const handler = (): void => {
    updates++;
  };
  c.viewer.addHandler('update-viewport', handler);
  for (let k = 0; k < 10; k++) {
    c.viewer.viewport.panBy(new OpenSeadragon.Point(0.001, 0), true);
    await frames(2);
  }
  c.viewer.removeHandler('update-viewport', handler);
  return { updates };
}

const api = {
  liveness,
  inspect,
  build,
  redrawAll,
  cellRects,
  analyzeScreenshot,
  panAll,
  addForeign,
  swapDrawers,
  destroyRange,
  probeSummary,
  probeRecords: (): object[] =>
    (window as unknown as { __ctxProbe?: { records(): object[] } }).__ctxProbe?.records() ?? [],
  voiTargetStats,
};

declare global {
  interface Window {
    __grid?: typeof api;
  }
}

window.__grid = api;
document.documentElement.dataset['ready'] = 'true';
