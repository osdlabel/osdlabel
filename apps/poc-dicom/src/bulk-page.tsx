/**
 * How far does "import DICOM bulk annotations as osdlabel annotations" go?
 * `?n=N` loads the first N nuclei polygons of a real IDC Microscopy Bulk
 * Simple Annotations object (55 092 polygons; IDC's p75 group is 441 105) as
 * ordinary annotations on a DICOM WSI in the stock <Annotator>, then times
 * mount-to-objects and a programmatic pan. The nuclei belong to another
 * slide; they are scaled onto the GTEx slide — geometry load is what matters.
 */
import { render } from 'solid-js/web';
import {
  Annotator,
  createAnnotationContextId,
  createAnnotationFromGeometry,
  type AnnotationContext,
  type AnnotationId,
  type ImageId,
  type OsdAnnotation,
} from '@osdlabel/solid';
import type { Point, VectorGeometry } from '@osdlabel/annotation';
import { readPart10 } from '@osdlabel/dicom';
import { readBulkAnnotations } from '@osdlabel/dicom-export';
import { wsiImageSource } from '@osdlabel/dicom-wsi';
import { loadWsi } from './wsi-source.js';

const params = new URLSearchParams(location.search);
/**
 * `mode=fabric` (default): each polygon is an ordinary osdlabel annotation, so a Fabric object.
 * `mode=layer` / `mode=lod`: none are annotations; a read-only companion canvas draws them on
 * every overlay sync (the DecorationLayer pattern: overlayElement + onSync); see attachLayer.
 */
const modeParam = params.get('mode');
const mode = modeParam === 'layer' || modeParam === 'lod' ? modeParam : 'fabric';
const n = Number(params.get('n') ?? 1000);
const panCount = Number(params.get('frames') ?? 20);
const timings: Record<string, number> = {};
let t = performance.now();

const index = (await (await fetch('/data-index.json')).json()) as Record<string, string[]>;
const annFile = index['3p-ann-nuclei']?.[0];
const bytes = new Uint8Array(await (await fetch(`/data/3p-ann-nuclei/${annFile}`)).arrayBuffer());
const groups = readBulkAnnotations(readPart10(bytes).dataset);
timings['ann-read-ms'] = performance.now() - t;
const all = groups.flatMap((g) => g.geometries);

t = performance.now();
const wsi = await loadWsi('sm-jpeg', 'dicomweb');
const source = wsiImageSource(wsi.pyramid, wsi.tileSource);
timings['wsi-metadata-ms'] = performance.now() - t;

// Take N polygons (file order is spatially coherent) and fit them into the GTEx tissue.
const picked = all.slice(0, n) as Extract<VectorGeometry, { type: 'polygon' }>[];
let minX = Infinity,
  minY = Infinity,
  maxX = -Infinity,
  maxY = -Infinity;
for (const g of picked)
  for (const p of g.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
const target = { x: 12000, y: 2000, w: 4000, h: 3000 };
const s = Math.min(target.w / (maxX - minX || 1), target.h / (maxY - minY || 1));
const map = (p: Point): Point => ({
  x: target.x + (p.x - minX) * s,
  y: target.y + (p.y - minY) * s,
});

const contextId = createAnnotationContextId('nuclei');
const CONTEXTS: AnnotationContext[] = [
  { id: contextId, label: 'Nuclei', tools: [{ type: 'polyline' }] },
];
t = performance.now();
const byId: Record<AnnotationId, OsdAnnotation> = {};
for (const g of mode === 'fabric' ? picked : []) {
  const a = createAnnotationFromGeometry(
    { type: 'polygon', points: g.points.map(map) },
    { imageId: source.id, contextId, toolType: 'polyline', label: 'Nuclei' },
  );
  byId[a.id] = a;
}
const initial = (mode === 'fabric' ? { [source.id]: byId } : {}) as Record<
  ImageId,
  Record<AnnotationId, OsdAnnotation>
>;
timings['build-annotations-ms'] = performance.now() - t;

interface CanvasLike {
  getObjects(): unknown[];
  renderAll(): void;
  getContext(): CanvasRenderingContext2D;
}

/** Wraps Fabric's renderAll to time every full render and count the ones that throw. */
const renders = { ms: [] as number[], errors: 0, lastError: '', culprit: '' };
function instrument(canvas: CanvasLike): void {
  const original = canvas.renderAll.bind(canvas);
  canvas.renderAll = () => {
    const t0 = performance.now();
    try {
      original();
    } catch (err) {
      renders.errors++;
      renders.lastError = String(err).slice(0, 160);
      if (!renders.culprit) {
        const objs = canvas.getObjects() as {
          type?: string;
          width?: number;
          height?: number;
          _cacheCanvas?: HTMLCanvasElement;
          id?: unknown;
        }[];
        const bad = objs.find(
          (o) => o._cacheCanvas && (o._cacheCanvas.width === 0 || o._cacheCanvas.height === 0),
        );
        renders.culprit = bad
          ? `${bad.type} id=${String(!!bad.id)} ${bad.width}x${bad.height} cache=${bad._cacheCanvas!.width}x${bad._cacheCanvas!.height}`
          : `none of ${objs.length} objects has a 0-size cache`;
      }
    } finally {
      renders.ms.push(performance.now() - t0);
    }
  };
}
function fabricObjects(): number {
  const el = document.querySelector('.openseadragon-canvas') as
    | (Element & { __osdOverlay?: { canvas?: CanvasLike } })
    | null;
  return el?.__osdOverlay?.canvas?.getObjects().length ?? -1;
}

interface OverlayLike {
  readonly canvas: CanvasLike & { readonly viewportTransform: readonly number[] };
  readonly overlayElement: HTMLElement;
  onSync(cb: () => void): () => void;
}
interface OsdPoint {
  x: number;
  y: number;
  times(f: number): OsdPoint;
}
interface OsdViewportLike {
  panBy(p: OsdPoint, immediately?: boolean): void;
  getCenter(): OsdPoint;
  zoomBy(f: number, ref?: OsdPoint, immediately?: boolean): void;
  fitBounds(r: unknown, immediately: boolean): void;
  imageToViewportRectangle(x: number, y: number, w: number, h: number): unknown;
}
type OverlayWithViewer = OverlayLike & { _viewer?: { viewport: OsdViewportLike } };
function overlay(): OverlayWithViewer | undefined {
  const el = document.querySelector('.openseadragon-canvas') as
    | (Element & { __osdOverlay?: OverlayWithViewer })
    | null;
  return el?.__osdOverlay;
}

type Vpt = [number, number, number, number, number, number];

/**
 * The batched alternatives to one Fabric object per polygon: a read-only companion canvas in
 * `overlayElement`, redrawn from `onSync` (the DecorationLayer pattern).
 *   layer: one Path2D of every polygon, stroked under the viewport transform each sync.
 *   lod:   a 256-px grid index; only visible cells are drawn; when the median nucleus is
 *          under 4 screen px each one becomes a 2x2 dot written straight into an ImageData.
 */
let layerFlush: (() => void) | undefined;
let layerReady = false;
const lodStats = { dotFrames: 0, pathFrames: 0, lastVisible: 0, medianScreenPx: 0 };
function attachLayer(ov: OverlayLike): void {
  t = performance.now();
  const polys = picked.map((g) => g.points.map(map));
  const closedPath = (list: readonly (readonly Point[])[]): Path2D => {
    const path = new Path2D();
    for (const pts of list) {
      const p0 = pts[0];
      if (!p0) continue;
      path.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]!.x, pts[i]!.y);
      // Close by returning to the first vertex, not closePath(): in Chromium 153 closePath() on a
      // many-subpath Path2D is quadratic (16 000 polygons: 9.9 s vs 24 ms; scripts/path2d-closepath-probe.mjs).
      path.lineTo(p0.x, p0.y);
    }
    return path;
  };
  // Centroids, extents and a grid index (used by lod only).
  const N = polys.length;
  const cx = new Float32Array(N);
  const cy = new Float32Array(N);
  const ext: number[] = [];
  const CELL = 256;
  const cols = Math.ceil(target.w / CELL) + 1;
  const rows = Math.ceil(target.h / CELL) + 1;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  polys.forEach((pts, i) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    cx[i] = (x0 + x1) / 2;
    cy[i] = (y0 + y1) / 2;
    ext.push(Math.max(x1 - x0, y1 - y0));
    const gx = Math.min(cols - 1, Math.max(0, Math.floor((cx[i]! - target.x) / CELL)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor((cy[i]! - target.y) / CELL)));
    cells[gy * cols + gx]!.push(i);
  });
  const medianExt = [...ext].sort((a, b) => a - b)[ext.length >> 1] ?? 0;
  const whole = mode === 'layer' ? closedPath(polys) : null;
  const cellPaths = new Map<number, Path2D>();
  timings['layer-build-ms'] = performance.now() - t;

  const host = ov.overlayElement;
  const c = document.createElement('canvas');
  c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
  host.appendChild(c);
  const g2d = c.getContext('2d')!;
  let img: ImageData | null = null;
  const draw = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(host.clientWidth * dpr);
    const h = Math.round(host.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.width = `${host.clientWidth}px`;
      c.style.height = `${host.clientHeight}px`;
      img = null;
    }
    g2d.setTransform(1, 0, 0, 1, 0, 0);
    g2d.clearRect(0, 0, w, h);
    const v = ov.canvas.viewportTransform as Vpt;
    const a = v[0] * dpr;
    const b = v[1] * dpr;
    const cc = v[2] * dpr;
    const d = v[3] * dpr;
    const e = v[4] * dpr;
    const f = v[5] * dpr;
    const zoom = Math.sqrt(a * a + b * b);
    if (whole) {
      g2d.setTransform(a, b, cc, d, e, f);
      g2d.lineWidth = 1.5 / zoom;
      g2d.strokeStyle = '#00e5ff';
      g2d.stroke(whole);
      return;
    }
    // Visible image-space rectangle: inverse transform of the four screen corners.
    const det = a * d - b * cc;
    let ix0 = Infinity;
    let iy0 = Infinity;
    let ix1 = -Infinity;
    let iy1 = -Infinity;
    for (const [sx, sy] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      const x = (d * (sx - e) - cc * (sy - f)) / det;
      const y = (-b * (sx - e) + a * (sy - f)) / det;
      ix0 = Math.min(ix0, x);
      iy0 = Math.min(iy0, y);
      ix1 = Math.max(ix1, x);
      iy1 = Math.max(iy1, y);
    }
    const gx0 = Math.max(0, Math.floor((ix0 - target.x) / CELL) - 1);
    const gy0 = Math.max(0, Math.floor((iy0 - target.y) / CELL) - 1);
    const gx1 = Math.min(cols - 1, Math.floor((ix1 - target.x) / CELL) + 1);
    const gy1 = Math.min(rows - 1, Math.floor((iy1 - target.y) / CELL) + 1);
    lodStats.medianScreenPx = medianExt * zoom;
    let visible = 0;
    if (medianExt * zoom < 4) {
      lodStats.dotFrames++;
      img ??= g2d.createImageData(w, h);
      const px = new Uint32Array(img.data.buffer);
      px.fill(0);
      const color = 0xffffe500; // ABGR as little-endian bytes: #00e5ff, opaque
      for (let gy = gy0; gy <= gy1; gy++)
        for (let gx = gx0; gx <= gx1; gx++)
          for (const i of cells[gy * cols + gx]!) {
            const sx = (a * cx[i]! + cc * cy[i]! + e) | 0;
            const sy = (b * cx[i]! + d * cy[i]! + f) | 0;
            if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
            const o = sy * w + sx;
            px[o] = px[o + 1] = px[o + w] = px[o + w + 1] = color;
            visible++;
          }
      g2d.putImageData(img, 0, 0);
    } else {
      lodStats.pathFrames++;
      g2d.setTransform(a, b, cc, d, e, f);
      g2d.lineWidth = 1.5 / zoom;
      g2d.strokeStyle = '#00e5ff';
      for (let gy = gy0; gy <= gy1; gy++)
        for (let gx = gx0; gx <= gx1; gx++) {
          const k = gy * cols + gx;
          const list = cells[k]!;
          if (!list.length) continue;
          let p = cellPaths.get(k);
          if (!p) {
            p = closedPath(list.map((i) => polys[i]!));
            cellPaths.set(k, p);
          }
          g2d.stroke(p);
          visible += list.length;
        }
    }
    lodStats.lastVisible = visible;
  };
  ov.onSync(draw);
  layerFlush = () => {
    draw();
    g2d.getImageData(0, 0, 1, 1);
  };
  draw();
  layerReady = true;
}

const tMount = performance.now();
render(
  () => (
    <div style={{ height: '100vh' }}>
      <Annotator images={[source]} contexts={CONTEXTS} initialAnnotations={initial} testMode />
    </div>
  ),
  document.getElementById('app')!,
);
const tMountDone = performance.now();

/** Puts the slide in the cell (as a user would, via the filmstrip) and waits for every Fabric object. */
async function openAndWait(): Promise<number> {
  const t0 = performance.now();
  (
    document.querySelector(`[data-testid="filmstrip-thumb-${source.id}"]`) as HTMLElement | null
  )?.click();
  for (;;) {
    await new Promise((r) => requestAnimationFrame(r));
    if (mode !== 'fabric') {
      const ov = overlay();
      if (ov && !layerReady) attachLayer(ov);
      if (layerReady) return performance.now() - t0;
    } else if (fabricObjects() >= n) return performance.now() - t0;
    if (performance.now() - t0 > 120000) return NaN;
  }
}

interface Stats {
  readonly median: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}
const stats = (xs: readonly number[]): Stats => {
  const s = [...xs].sort((x, y) => x - y);
  return {
    median: s[s.length >> 1] ?? null,
    p90: s[Math.floor(s.length * 0.9)] ?? null,
    max: s[s.length - 1] ?? null,
  };
};

/** rAF-to-rAF frame times while panning by +-0.2 % of the viewport width each frame. */
async function panFrames(vp: OsdViewportLike | undefined, frames = 40): Promise<Stats> {
  const dts: number[] = [];
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    if (vp) {
      // A fresh OSD Point (its prototype has no usable constructor): zero it, set dx.
      const dlt = vp.getCenter().times(0);
      dlt.x = i % 2 ? 0.002 : -0.002;
      vp.panBy(dlt, true);
    }
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    dts.push(now - last);
    last = now;
  }
  return stats(dts);
}

const api = {
  n,
  timings,
  async measure() {
    timings['mount-ms'] = tMountDone - tMount;
    const mountToObjectsMs = await openAndWait();
    const ov = overlay();
    const canvas = ov?.canvas;
    if (canvas && mode === 'fabric') instrument(canvas);
    const vp = ov?._viewer?.viewport;
    const phases: Record<string, unknown> = {};
    // fit: every nucleus in view, all sub-pixel (as at a whole-slide view). zoom8 / zoom64:
    // 1/64 and 1/4096 of the area in view, nuclei ~2 px and ~15 px across.
    for (const [name, zoomBy] of [
      ['fit', 1],
      ['zoom8', 8],
      ['zoom64', 64],
    ] as const) {
      vp?.fitBounds(vp.imageToViewportRectangle(target.x, target.y, target.w, target.h), true);
      if (zoomBy !== 1) vp?.zoomBy(zoomBy, vp.getCenter(), true);
      await new Promise((r) => setTimeout(r, 600));
      renders.ms.length = 0;
      renders.errors = 0;
      const pan = await panFrames(vp, panCount);
      const fabricRender = stats(renders.ms);
      // Canvas 2D records draw calls and rasterises later, so a timer around stroke() or
      // renderAll() sees only the recording. Force the raster with a 1-px readback, 10 times.
      const flushed: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        if (mode !== 'fabric') layerFlush?.();
        else if (canvas) {
          canvas.renderAll();
          canvas.getContext().getImageData(0, 0, 1, 1);
        }
        flushed.push(performance.now() - t0);
      }
      phases[name] = {
        panFrameMs: pan,
        fabricRenderAllMs: mode === 'fabric' ? fabricRender : null,
        renderErrors: renders.errors,
        drawFlushedMs: stats(flushed),
        ...(mode === 'lod' ? { lod: { ...lodStats } } : {}),
      };
    }
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      ?.usedJSHeapSize;
    const points = picked.reduce((k, g) => k + g.points.length, 0);
    return {
      mode,
      n: picked.length,
      points,
      objects: fabricObjects(),
      mountToObjectsMs,
      phases,
      heapMB: heap ? heap / 2 ** 20 : null,
      ...timings,
    };
  },
};
(window as unknown as { __bulk: typeof api }).__bulk = api;
document.body.dataset['ready'] = '1';
