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

const n = Number(new URLSearchParams(location.search).get('n') ?? 1000);
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
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const g of picked) for (const p of g.points) {
  minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
}
const target = { x: 12000, y: 2000, w: 4000, h: 3000 };
const s = Math.min(target.w / (maxX - minX || 1), target.h / (maxY - minY || 1));
const map = (p: Point): Point => ({ x: target.x + (p.x - minX) * s, y: target.y + (p.y - minY) * s });

const contextId = createAnnotationContextId('nuclei');
const CONTEXTS: AnnotationContext[] = [{ id: contextId, label: 'Nuclei', tools: [{ type: 'polyline' }] }];
t = performance.now();
const byId: Record<AnnotationId, OsdAnnotation> = {};
for (const g of picked) {
  const a = createAnnotationFromGeometry(
    { type: 'polygon', points: g.points.map(map) },
    { imageId: source.id, contextId, toolType: 'polyline', label: 'Nuclei' },
  );
  byId[a.id] = a;
}
const initial = { [source.id]: byId } as Record<ImageId, Record<AnnotationId, OsdAnnotation>>;
timings['build-annotations-ms'] = performance.now() - t;

interface CanvasLike {
  getObjects(): unknown[];
  renderAll(): void;
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
        const objs = canvas.getObjects() as { type?: string; width?: number; height?: number; _cacheCanvas?: HTMLCanvasElement; id?: unknown }[];
        const bad = objs.find((o) => o._cacheCanvas && (o._cacheCanvas.width === 0 || o._cacheCanvas.height === 0));
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
  const el = document.querySelector('.openseadragon-canvas') as (Element & { __osdOverlay?: { canvas?: CanvasLike } }) | null;
  return el?.__osdOverlay?.canvas?.getObjects().length ?? -1;
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

/** Puts the slide in the cell (as a user would, via the filmstrip) and waits for every Fabric object. */
const tMountDone = performance.now();

async function openAndWait(): Promise<number> {
  const t0 = performance.now();
  (document.querySelector(`[data-testid="filmstrip-thumb-${source.id}"]`) as HTMLElement | null)?.click();
  for (;;) {
    await new Promise((r) => requestAnimationFrame(r));
    const k = fabricObjects();
    if (k >= n) return performance.now() - t0;
    if (performance.now() - t0 > 120000) return NaN;
  }
}

async function panFrames(frames = 40): Promise<{ medianMs: number; p90Ms: number; maxMs: number }> {
  interface OsdPoint {
    x: number;
    y: number;
    times(f: number): OsdPoint;
  }
  const el = document.querySelector('.openseadragon-canvas') as Element & {
    __osdOverlay?: { _viewer?: { viewport: { panBy(p: OsdPoint, immediately?: boolean): void; getCenter(): OsdPoint } } };
  };
  const vp = el.__osdOverlay?._viewer?.viewport;
  const dts: number[] = [];
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    if (vp) {
      // A fresh OSD Point (its prototype has no usable constructor): zero it, set dx.
      const d = vp.getCenter().times(0);
      d.x = i % 2 ? 0.002 : -0.002;
      vp.panBy(d, true);
    }
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    dts.push(now - last);
    last = now;
  }
  const sorted = [...dts].sort((a, b) => a - b);
  return { medianMs: sorted[sorted.length >> 1]!, p90Ms: sorted[Math.floor(sorted.length * 0.9)]!, maxMs: sorted[sorted.length - 1]! };
}

const api = {
  n,
  timings,
  async measure() {
    timings['mount-ms'] = tMountDone - tMount;
    const mountToObjectsMs = await openAndWait();
    const canvas = (document.querySelector('.openseadragon-canvas') as (Element & { __osdOverlay?: { canvas?: CanvasLike } }) | null)?.__osdOverlay?.canvas;
    if (canvas) instrument(canvas);
    // Zoom so the nuclei fill the view, then pan.
    const el = document.querySelector('.openseadragon-canvas') as Element & { __osdOverlay?: { _viewer?: { viewport: { fitBounds(r: unknown, i: boolean): void; imageToViewportRectangle(x: number, y: number, w: number, h: number): unknown } } } };
    const vp = el.__osdOverlay?._viewer?.viewport;
    vp?.fitBounds(vp.imageToViewportRectangle(target.x, target.y, target.w, target.h), true);
    await new Promise((r) => setTimeout(r, 500));
    renders.ms.length = 0;
    renders.errors = 0;
    const pan = await panFrames();
    const r = [...renders.ms].sort((a, b) => a - b);
    const render = { calls: r.length, medianMs: r[r.length >> 1] ?? null, p90Ms: r[Math.floor(r.length * 0.9)] ?? null, errors: renders.errors, lastError: renders.lastError, culprit: renders.culprit };
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return { n, objects: fabricObjects(), mountToObjectsMs, pan, render, heapMB: heap ? heap / 2 ** 20 : null, ...timings };
  },
};
(window as unknown as { __bulk: typeof api }).__bulk = api;
document.body.dataset['ready'] = '1';
