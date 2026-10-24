/**
 * H2 + H3 harness: OpenSeadragon + FabricOverlay + the SAM tool on a
 * synthetic 100k x 80k DZI, with inference in a worker (or on a server).
 * The runner drives it with real mouse events and reads `window.__e2e`.
 */
import OpenSeadragon from 'openseadragon';
import type { Point } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { buildMaskFabricObject, type ToolCallbacks } from '@osdlabel/fabric-annotations';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import { encodeCanonical } from '@osdlabel/mask';
import { binaryIou, fillRings, type Ring } from '@osdlabel/mask-contour';
import { describeOsdTileSource, type TilePyramid } from '@osdlabel/region-reader';
import { stats } from './stats.js';
import {
  rasterImageBounds,
  rasterToMaskSnapshot,
  rasterToPolygons,
  type SegmentationProvider,
  type SegmentationTarget,
} from '@osdlabel/segmentation';
import { SegmentationTool, type SegmentationToolEvent } from '@osdlabel/segmentation-fabric';
import { OnnxSamModel, createOnnxSamProvider } from '@osdlabel/segmentation-onnx';
import { createRemoteSegmentationProvider } from '@osdlabel/segmentation-remote';
import { WorkerSegmentationProvider } from '@osdlabel/segmentation-worker';
import { browserTileIO } from '@osdlabel/region-reader';
import { loadOrt } from './ort-runtime.js';
import { createImageId } from '@osdlabel/viewer-api';
import { createMaskAnnotation, getScenePointFromEvent, processToolAddAnnotation } from 'osdlabel';
import { findSpec, modelUrl } from './model-specs.js';
import type { SamWorkerConfig } from './sam-worker.js';

type Mode = 'local' | 'local-main' | 'remote-encoder' | 'remote-all';

export interface E2eInit {
  readonly image: 'synth' | 'sample';
  readonly model: string;
  readonly mode: Mode;
  readonly threads: number;
}

/** Ground truth for a synthetic object, to check the whole coordinate pipeline. */
export type GroundTruth =
  | {
      readonly kind: 'ellipse';
      readonly x: number;
      readonly y: number;
      readonly rx: number;
      readonly ry: number;
    }
  | { readonly kind: 'none' };

const IMAGES = {
  synth: { url: '/synth/gigapixel.dzi', key: 'synth' },
  sample: { url: '/sample/tiled.dzi', key: 'sample' },
} as const;

const CONTEXT = createAnnotationContextId('poc');
const MEASURE_CAP = 128 * 1024 * 1024; // never allocate more than this to *measure*

const events: (SegmentationToolEvent & { readonly at: number })[] = [];
let viewer: OpenSeadragon.Viewer | null = null;
let overlay: FabricOverlay | null = null;
let tool: SegmentationTool | null = null;
let provider: SegmentationProvider | null = null;
let workerProvider: WorkerSegmentationProvider<SamWorkerConfig> | null = null;
let imageKey = 'synth';
const committed: unknown[] = [];

/** rAF timestamps: the main thread's responsiveness while inference runs. */
const frames: number[] = [];
function frameLoop(t: number): void {
  frames.push(t);
  if (frames.length > 20_000) frames.splice(0, 10_000);
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

/**
 * Long tasks (> 50 ms on the main thread), from the Long Tasks API: the
 * standard measure of how long the page could not respond to input.
 */
const longTasks: { start: number; duration: number }[] = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
} catch {
  // Not supported: the frame statistics below still apply.
}

function frameStatsSince(t0: number): unknown {
  const now = performance.now();
  const ts = frames.filter((t) => t >= t0);
  // Bracket with the window's ends: a block before the first frame (or after
  // the last) is a gap too. Without this, a page frozen for 3.6 s that then
  // paints 6 quick frames reported a 16.7 ms maximum gap.
  const bounds = [t0, ...ts, now];
  const gaps: number[] = [];
  for (let i = 1; i < bounds.length; i++) gaps.push(bounds[i]! - bounds[i - 1]!);
  const s = stats(gaps);
  const lt = longTasks.filter((e) => e.start + e.duration >= t0 && e.start <= now);
  return {
    windowMs: now - t0,
    frames: ts.length,
    fps: (ts.length * 1000) / Math.max(1, now - t0),
    maxGap: s.max,
    p90Gap: s.p90,
    longFrames: gaps.filter((g) => g > 50).length,
    longTasks: lt.length,
    longTaskMs: lt.reduce((sum, e) => sum + e.duration, 0),
    longestTaskMs: lt.reduce((m, e) => Math.max(m, e.duration), 0),
  };
}

function emit(e: SegmentationToolEvent): void {
  // Drop the raster payloads from what the runner reads back.
  events.push({ ...e, at: performance.now() });
}

function imageSize(): { width: number; height: number } {
  const item = viewer?.world.getItemAt(0);
  if (!item) throw new Error('no image');
  const s = item.getContentSize();
  return { width: s.x, height: s.y };
}

function getTarget(): SegmentationTarget | null {
  const v = viewer;
  if (!v || !v.world.getItemAt(0)) return null;
  const size = imageSize();
  const vp = v.viewport;
  const b = vp.viewportToImageRectangle(vp.getBounds(true));
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(size.width, b.x + b.width);
  const y1 = Math.min(size.height, b.y + b.height);
  return {
    imageKey,
    imageSize: size,
    viewport: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    viewportScale: vp.viewportToImageZoom(vp.getZoom(true)),
  };
}

function waitOpen(v: OpenSeadragon.Viewer): Promise<void> {
  return new Promise((resolve, reject) => {
    v.addOnceHandler('open', () => resolve());
    v.addOnceHandler('open-failed', (e) =>
      reject(new Error(String((e as { message?: string }).message))),
    );
  });
}

/**
 * Waits until OSD has no tile jobs running or queued for 300 ms (the view has
 * "settled"), or the timeout passes. `fully-loaded-change` is not reliable
 * here: OSD keeps refining towards higher levels.
 */
async function waitTilesSettled(timeoutMs = 20_000): Promise<boolean> {
  const loader = (
    viewer as unknown as { imageLoader?: { jobsInProgress: number; jobQueue: unknown[] } }
  )?.imageLoader;
  if (!loader) return false;
  const t0 = performance.now();
  let quiet = 0;
  while (performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    quiet = loader.jobsInProgress === 0 && loader.jobQueue.length === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return true;
  }
  return false;
}

async function init(cfg: E2eInit): Promise<unknown> {
  const spec = findSpec(cfg.model);
  const img = IMAGES[cfg.image];
  imageKey = img.key;
  const el = document.getElementById('viewer');
  if (!el) throw new Error('#viewer missing');
  viewer = OpenSeadragon({
    element: el,
    prefixUrl: '',
    showNavigationControl: false,
    animationTime: 0,
    springStiffness: 100,
    maxZoomPixelRatio: 4,
    crossOriginPolicy: false,
    imageLoaderLimit: 8,
  });
  const opened = waitOpen(viewer);
  viewer.open(img.url);
  await opened;
  overlay = new FabricOverlay(viewer, { testMode: true });
  const tileSource = viewer.world.getItemAt(0)!.source;
  const pyramid: TilePyramid | null = describeOsdTileSource(
    tileSource as unknown as Parameters<typeof describeOsdTileSource>[0],
  );
  if (!pyramid) throw new Error('tile source not describable');
  // Absolute URLs: the worker resolves relative ones against its own script.
  // (URL() would percent-encode the {level}/{x}/{y} placeholders.)
  const abs = (u: string): string => (u.startsWith('/') ? `${location.origin}${u}` : u);
  const absolute: TilePyramid =
    pyramid.kind === 'dzi'
      ? { ...pyramid, tileUrlTemplate: abs(pyramid.tileUrlTemplate) }
      : { ...pyramid, url: abs(pyramid.url) };

  let info: unknown = null;
  if (cfg.mode === 'remote-all') {
    provider = createRemoteSegmentationProvider({
      url: '/api/sam/segment',
      capabilities: {
        box: true,
        negativePoints: true,
        multimask: true,
        maskInput: false,
        inputSize: spec.inputSize,
      },
      fetch: (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        return fetch(input, { ...init, body: JSON.stringify({ ...body, model: cfg.model }) });
      },
    });
  } else if (cfg.mode === 'local-main') {
    // Everything on the main thread: the comparison that justifies the worker.
    const { ort } = await loadOrt('wasm', cfg.threads);
    const model = await OnnxSamModel.load(ort, {
      family: spec.family,
      inputSize: spec.inputSize,
      encoder: await modelUrl(spec.encoder),
      decoder: await modelUrl(spec.decoder, spec.decoderFallback),
    });
    provider = createOnnxSamProvider(model, () => absolute, browserTileIO());
    info = { load: model.loadTimings };
  } else {
    const worker = new Worker(new URL('./sam-worker.ts', import.meta.url), { type: 'module' });
    workerProvider = new WorkerSegmentationProvider<SamWorkerConfig>(worker);
    info = await workerProvider.init({
      family: spec.family,
      inputSize: spec.inputSize,
      encoderUrl: await modelUrl(spec.encoder),
      decoderUrl: await modelUrl(spec.decoder, spec.decoderFallback),
      ep: 'wasm',
      threads: cfg.threads,
      mode: cfg.mode,
      remoteUrl: new URL('/api/sam/encode', location.href).href,
      remoteModel: cfg.model,
      pyramids: { [img.key]: absolute },
    });
    provider = workerProvider;
  }

  const imageId = createImageId(img.key);
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => CONTEXT,
    getToolConstraint: () => undefined,
    canAddAnnotation: () => true,
    addAnnotation: (p) => {
      committed.push(processToolAddAnnotation(p));
    },
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };
  tool = new SegmentationTool({
    provider,
    getTarget,
    onEvent: emit,
    onCommitMask: (c) => {
      const t0 = performance.now();
      const ann = createMaskAnnotation(c.snapshot, {
        imageId: c.imageId,
        contextId: c.contextId,
        toolType: 'segmentation',
      });
      const t1 = performance.now();
      const raw = ann.rawAnnotationData;
      if (raw.format !== 'osdlabel-mask') return;
      const obj = buildMaskFabricObject(raw, { id: ann.id });
      const t2 = performance.now();
      if (obj) overlay?.canvas.add(obj);
      overlay?.canvas.requestRenderAll();
      committed.push({
        id: ann.id,
        createMs: t1 - t0,
        renderBuildMs: t2 - t1,
        countsBytes: raw.data.counts.length,
      });
    },
  });
  overlay.setMode('paint');
  tool.activate(overlay, imageId, callbacks, {} as never);
  const ov = overlay;
  const toImage = (p: Point): Point => ov.screenToImage(p);
  ov.canvas.on('mouse:down', (opt) =>
    tool?.onPointerDown(opt.e as PointerEvent, getScenePointFromEvent(toImage, opt)),
  );
  ov.canvas.on('mouse:move', (opt) =>
    tool?.onPointerMove(opt.e as PointerEvent, getScenePointFromEvent(toImage, opt)),
  );
  ov.canvas.on('mouse:up', (opt) =>
    tool?.onPointerUp(opt.e as PointerEvent, getScenePointFromEvent(toImage, opt)),
  );
  return {
    info,
    imageSize: imageSize(),
    pyramid: absolute,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  };
}

async function view(p: {
  cx: number;
  cy: number;
  zoom: number;
  waitTiles?: boolean;
}): Promise<unknown> {
  const v = viewer!;
  const vp = v.viewport;
  vp.zoomTo(vp.imageToViewportZoom(p.zoom), undefined, true);
  vp.panTo(vp.imageToViewportCoordinates(p.cx, p.cy), true);
  v.forceRedraw();
  const t0 = performance.now();
  const loaded = p.waitTiles === false ? null : await waitTilesSettled();
  return { target: getTarget(), tilesLoaded: loaded, tileWaitMs: performance.now() - t0 };
}

function toScreen(p: Point): Point {
  const s = overlay!.imageToScreen(p);
  const r = document.getElementById('viewer')!.getBoundingClientRect();
  return { x: r.left + s.x, y: r.top + s.y };
}

function eventsSince(i: number): unknown[] {
  return events.slice(i).map((e) => {
    if (e.type === 'result') {
      const { result, ...rest } = e;
      return {
        ...rest,
        cached: result.cached,
        timings: result.timings,
        view: result.view,
        candidates: result.candidates.map((c) => ({
          predictedIou: c.predictedIou,
          frame: c.mask.frame,
        })),
      };
    }
    if (e.type === 'capacity')
      return { type: e.type, requested: e.error.requestedPixels, max: e.error.maxPixels };
    if (e.type === 'error') return { type: e.type, error: String(e.error) };
    return e;
  });
}

/** Waits until a 'painted' (or 'error') event arrives after index `from`. */
async function waitPainted(from: number, timeoutMs = 300_000): Promise<unknown[]> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (events.slice(from).some((e) => e.type === 'painted' || e.type === 'error')) {
      return [...eventsSince(from), { type: 'frames', ...(frameStatsSince(markedAt) as object) }];
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return [...eventsSince(from), { type: 'timeout' }];
}
let markedAt = 0;

function ellipseRing(gt: Extract<GroundTruth, { kind: 'ellipse' }>, n = 256): Ring {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: gt.x + gt.rx * Math.cos(a), y: gt.y + gt.ry * Math.sin(a) };
  });
}

/**
 * H3 measurements on the current best candidate, without committing:
 * raster -> polygon and raster -> #149 mask snapshot (+ canonical RLE,
 * + Fabric render object), their agreement, and agreement with ground truth.
 */
function analyze(gt: GroundTruth): unknown {
  const best = tool?.currentCandidate;
  const target = getTarget();
  if (!best || !target) return { error: 'no candidate' };
  const out: Record<string, unknown> = { frame: best.mask.frame, predictedIou: best.predictedIou };
  const f = best.mask.frame;

  let t0 = performance.now();
  const polys = rasterToPolygons(best.mask, {
    tolerance: 0.25 * Math.min(f.pixelWidth, f.pixelHeight),
  });
  out['polygonMs'] = performance.now() - t0;
  out['polygonRings'] = polys.length;
  out['polygonVertices'] = polys[0]?.outer.length ?? 0;
  out['polygonHoles'] = polys[0]?.holes.length ?? 0;

  const box = rasterImageBounds(best.mask, target.imageSize);
  const boxPixels = box ? box.width * box.height : 0;
  out['maskBoxPixels'] = boxPixels;
  out['exceeds149Cap'] = boxPixels > 64 * 1024 * 1024;
  if (box && boxPixels <= MEASURE_CAP) {
    t0 = performance.now();
    const snap = rasterToMaskSnapshot(best.mask, target.imageSize, { maxPixels: MEASURE_CAP });
    out['maskMs'] = performance.now() - t0;
    out['maskSnapshot'] = { x: snap.x, y: snap.y, width: snap.width, height: snap.height };
    let fg = 0;
    for (let i = 0; i < snap.data.length; i++) fg += snap.data[i]!;
    out['maskPixels'] = fg;
    t0 = performance.now();
    const canonical = encodeCanonical(snap);
    out['canonicalMs'] = performance.now() - t0;
    out['canonicalBytes'] = canonical.counts.length;
    if (snap.width * snap.height <= 64 * 1024 * 1024) {
      t0 = performance.now();
      const obj = buildMaskFabricObject(
        { format: 'osdlabel-mask', data: { ...canonical } },
        { id: 'probe' },
      );
      out['renderBuildMs'] = performance.now() - t0;
      out['renderCanvasPixels'] = snap.width * snap.height;
      void obj;
    }
    // Polygon vs mask agreement (outer ring of every component, holes too).
    const rings: Ring[] = polys.flatMap((p) => [p.outer, ...p.holes]);
    t0 = performance.now();
    const filled = fillRings(rings, snap.width, snap.height, snap.x, snap.y);
    out['polygonVsMaskIoU'] = binaryIou(filled, snap.data);
    out['fillMs'] = performance.now() - t0;
    if (gt.kind === 'ellipse') {
      // IoU against the analytic object over the union of both boxes.
      const x0 = Math.floor(Math.min(snap.x, gt.x - gt.rx));
      const y0 = Math.floor(Math.min(snap.y, gt.y - gt.ry));
      const x1 = Math.ceil(Math.max(snap.x + snap.width, gt.x + gt.rx));
      const y1 = Math.ceil(Math.max(snap.y + snap.height, gt.y + gt.ry));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w * h <= MEASURE_CAP) {
        const truth = fillRings([ellipseRing(gt)], w, h, x0, y0);
        const mask = new Uint8Array(w * h);
        for (let r = 0; r < snap.height; r++) {
          mask.set(
            snap.data.subarray(r * snap.width, (r + 1) * snap.width),
            (snap.y - y0 + r) * w + (snap.x - x0),
          );
        }
        out['groundTruthIoU'] = binaryIou(mask, truth);
        // The same for the polygon, which is what a coarse-zoom commit stores.
        const polyFilled = fillRings(rings, w, h, x0, y0);
        out['groundTruthIoUPolygon'] = binaryIou(polyFilled, truth);
      }
    }
  } else {
    out['maskSkipped'] = `mask box ${(boxPixels / 1e6).toFixed(0)} Mpx > measurement cap`;
  }
  return out;
}

declare global {
  interface Window {
    __e2e?: {
      init(cfg: E2eInit): Promise<unknown>;
      view(p: { cx: number; cy: number; zoom: number; waitTiles?: boolean }): Promise<unknown>;
      toScreen(p: Point): Point;
      mark(): number;
      waitPainted(from: number, timeoutMs?: number): Promise<unknown[]>;
      analyze(gt: GroundTruth): unknown;
      commit(output: 'mask' | 'polygon'): {
        output: string | null;
        events: unknown[];
        committed: unknown;
      };
      cancel(): void;
      prepare(): Promise<number>;
      cacheStats(): Promise<unknown>;
      target(): SegmentationTarget | null;
      memory(): unknown;
    };
  }
}

window.__e2e = {
  init,
  view,
  toScreen,
  mark: () => {
    markedAt = performance.now();
    return events.length;
  },
  waitPainted,
  analyze,
  commit(output) {
    const from = events.length;
    const before = committed.length;
    const result = tool!.commit(output);
    return { output: result, events: eventsSince(from), committed: committed.slice(before) };
  },
  cancel: () => tool?.cancel(),
  async prepare() {
    const t0 = performance.now();
    await tool?.prepare();
    return performance.now() - t0;
  },
  cacheStats: async () => (workerProvider ? workerProvider.configure({ cacheStats: true }) : null),
  target: getTarget,
  memory: () => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return m ? { usedJSHeapMB: m.usedJSHeapSize / 2 ** 20 } : null;
  },
};

const status = document.getElementById('status');
if (status) status.textContent = 'ready';
