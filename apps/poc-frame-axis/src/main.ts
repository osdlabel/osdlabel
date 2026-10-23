/**
 * Frame-axis harness page. Exposes `window.__poc` for scripts/bench.mjs.
 *
 * One OSD viewer + FabricOverlay (+ DecorationLayer) in a 768x768 cell, a
 * synthetic stack, a display strategy (how OSD shows frame i) and an
 * annotation layer strategy (how Fabric swaps per-frame annotations). Every
 * frame change goes through `apply()`, which logs to the display recorder.
 */
import OpenSeadragon from 'openseadragon';
import type { FabricObject } from 'fabric';
import { DecorationLayer, FabricOverlay, computeViewportTransform } from '@osdlabel/fabric-osd';
import { DEFAULT_VIEWER_OPTIONS } from '@osdlabel/osd-helper';
import type { FrameSource } from '@osdlabel/frame-osd';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { DecorationProvider } from '@osdlabel/decoration';
import { createLabelProvider, createMeasurementProvider } from '@osdlabel/decoration';
import { stepFrameIndex } from '@osdlabel/frame';
import type { OsdAnnotation, OsdFields } from 'osdlabel';
import { lesionsOnSlice, renderCtStack } from './data/ct-phantom.js';
import { renderUltrasoundFrame, chamberAt } from './data/ultrasound.js';
import { decodeFrameMarker, markerBlockCenter, MARKER_BITS } from './data/marker.js';
import {
  BitmapFrameStore,
  Gray8FrameStore,
  RgbaFrameStore,
  grayStackToBitmaps,
} from './data/frame-stores.js';
import type { DisplayStrategy, StrategyName } from './display/strategies.js';
import {
  MutableTile,
  MutableTileNoInvalidate,
  OpacityPreload,
  OpenPerFrame,
  OpenPngPerFrame,
  ResetInPlace,
  encodePngUrls,
} from './display/strategies.js';
import { fixtureGeometry } from './annotations/fixtures.js';
import type { AnnotationLayer, AnnotationSwapName } from './annotations/layers.js';
import { buildAnnotation, createAnnotationLayer, fabricTuning } from './annotations/layers.js';
import { canvasTag, FrameRateProbe, Recorder, sleep, waitFrames } from './instrument/recorder.js';
import { analyzeDisplayLog } from './instrument/display-log.js';
import { summarize, roundDeep } from './instrument/stats.js';
import { runCine } from './cine.js';
import type { CineOptions } from './cine.js';

export interface SetupOptions {
  readonly strategy: StrategyName;
  readonly drawer: 'webgl' | 'canvas';
  readonly data: 'ct' | 'us';
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: 'gray8' | 'bitmap' | 'rgba';
  readonly annotationsPerFrame: number;
  readonly layer: AnnotationSwapName;
  readonly decorations: boolean;
  readonly silenceMultiImageWarnings?: boolean;
  /** Fabric per-object render caching (Fabric default: true). */
  readonly objectCaching?: boolean;
}

interface Session {
  readonly opts: SetupOptions;
  readonly viewer: OpenSeadragon.Viewer;
  readonly overlay: FabricOverlay;
  readonly decorationLayer: DecorationLayer | undefined;
  readonly strategy: DisplayStrategy;
  readonly annotationLayer: AnnotationLayer | undefined;
  readonly byFrame: readonly (readonly OsdAnnotation[])[];
  readonly source: FrameSource & { paintMs: number; paints: number };
  readonly recorder: Recorder;
  readonly providers: readonly DecorationProvider<OsdFields>[];
  readonly applyTimings: { image: number; ann: number; deco: number }[];
  readonly renderMs: number[];
  readonly drawMs: number[];
  readonly consoleErrors: { count: number };
  current: number;
  initialZoom: number;
}

let session: Session | undefined;
const cell = document.getElementById('cell') as HTMLDivElement;
const imageId = createImageId('stack-1');
const contextId = createAnnotationContextId('ctx');

interface WorldItemLike {
  getOpacity(): number;
  getTilesToDraw(): { tile: { getCanvasContext?: () => CanvasRenderingContext2D | null } }[];
  source: { url?: string };
}

/** Frame index OSD just drew: from the tags on the drawn tiles' canvases (-1 blank, -2 mixed). */
const urlFrames = new Map<string, number>();
function drawnFrame(viewer: OpenSeadragon.Viewer): number {
  let result: number | undefined;
  const world = viewer.world;
  for (let i = 0; i < world.getItemCount(); i++) {
    const item = world.getItemAt(i) as unknown as WorldItemLike;
    if (item.getOpacity() === 0) continue;
    const tiles = item.getTilesToDraw();
    if (tiles.length === 0) {
      result ??= -1;
      continue;
    }
    for (const t of tiles) {
      const f =
        canvasTag(t.tile.getCanvasContext?.()?.canvas) ??
        (item.source.url !== undefined ? urlFrames.get(item.source.url) : undefined);
      if (f === undefined) continue;
      if (result === undefined || result === -1) result = f;
      else if (result !== f) result = -2;
    }
  }
  return result ?? -1;
}

async function buildSource(opts: SetupOptions): Promise<{
  source: FrameSource & { paintMs: number; paints: number };
  genMs: number;
  convertMs: number;
  bytes: number;
}> {
  const t0 = performance.now();
  if (opts.data === 'ct') {
    const gray = renderCtStack(opts.frames, opts.width, opts.height);
    const genMs = performance.now() - t0;
    if (opts.pixels === 'gray8') {
      return {
        source: new Gray8FrameStore(opts.width, opts.height, opts.frames, gray),
        genMs,
        convertMs: 0,
        bytes: gray.byteLength,
      };
    }
    const t1 = performance.now();
    const bitmaps = await grayStackToBitmaps(opts.width, opts.height, opts.frames, gray);
    return {
      source: new BitmapFrameStore(opts.width, opts.height, bitmaps),
      genMs,
      convertMs: performance.now() - t1,
      bytes: opts.width * opts.height * 4 * opts.frames,
    };
  }
  const frames: ImageData[] = [];
  for (let i = 0; i < opts.frames; i++) {
    const img = new ImageData(opts.width, opts.height);
    renderUltrasoundFrame(i, opts.width, opts.height, img.data);
    frames.push(img);
  }
  const genMs = performance.now() - t0;
  if (opts.pixels === 'bitmap') {
    const t1 = performance.now();
    const bitmaps = await Promise.all(frames.map((f) => createImageBitmap(f)));
    return {
      source: new BitmapFrameStore(opts.width, opts.height, bitmaps),
      genMs,
      convertMs: performance.now() - t1,
      bytes: opts.width * opts.height * 4 * opts.frames,
    };
  }
  return {
    source: new RgbaFrameStore(opts.width, opts.height, frames),
    genMs,
    convertMs: 0,
    bytes: opts.width * opts.height * 4 * opts.frames,
  };
}

function buildAnnotations(opts: SetupOptions): OsdAnnotation[][] {
  const out: OsdAnnotation[][] = [];
  if (opts.annotationsPerFrame <= 0) return Array.from({ length: opts.frames }, () => []);
  for (let f = 0; f < opts.frames; f++) {
    const anchors =
      opts.data === 'ct'
        ? lesionsOnSlice(f, opts.frames, opts.width, opts.height)
        : (() => {
            const c = chamberAt(f, opts.width, opts.height);
            return [{ x: c.cx, y: c.cy, r: Math.max(c.rx, c.ry) }];
          })();
    out.push(
      fixtureGeometry(f, opts.annotationsPerFrame, opts.width, opts.height, anchors).map((spec) =>
        buildAnnotation(spec, imageId, contextId, `uid-${f}`),
      ),
    );
  }
  return out;
}

async function setup(opts: SetupOptions): Promise<Record<string, unknown>> {
  await teardown();
  fabricTuning.objectCaching = opts.objectCaching ?? true;
  const tStart = performance.now();
  const { source, genMs, convertMs, bytes } = await buildSource(opts);

  const consoleErrors = { count: 0 };
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleErrors.count++;
    if (consoleErrors.count <= 3) origError(...args);
  };

  const viewer = OpenSeadragon({
    ...DEFAULT_VIEWER_OPTIONS,
    element: cell,
    drawer: opts.drawer,
    immediateRender: true,
    imageLoaderLimit: 0,
    preserveViewport: true,
    maxImageCacheCount: Math.max(200, opts.frames * 2 + 10),
    silenceMultiImageWarnings: opts.silenceMultiImageWarnings ?? false,
  } as OpenSeadragon.Options);

  let strategy: DisplayStrategy;
  let pngMs = 0;
  switch (opts.strategy) {
    case 'open':
      strategy = new OpenPerFrame(viewer, source);
      break;
    case 'open-png': {
      const t = performance.now();
      const urls = await encodePngUrls(source);
      pngMs = performance.now() - t;
      urls.forEach((u, i) => urlFrames.set(u, i));
      strategy = new OpenPngPerFrame(viewer, urls);
      break;
    }
    case 'reset':
      strategy = new ResetInPlace(viewer, source);
      break;
    case 'opacity':
      strategy = new OpacityPreload(viewer, source);
      break;
    case 'mutable':
      strategy = new MutableTile(viewer, source);
      break;
    case 'mutable-noinval':
      strategy = new MutableTileNoInvalidate(viewer, source);
      break;
  }
  const tOpen = performance.now();
  await strategy.open();
  const openMs = performance.now() - tOpen;

  const overlay = new FabricOverlay(viewer);
  const decorationLayer = opts.decorations ? new DecorationLayer(overlay) : undefined;
  // A non-trivial view (zoomed ~1.25x, marker corner still on screen), so the
  // overlay's transform is not the identity when its exactness is checked.
  viewer.viewport.fitBounds(new OpenSeadragon.Rect(-0.02, -0.02, 0.8, 0.8), true);
  overlay.sync();

  const tAnn = performance.now();
  const byFrame = buildAnnotations(opts);
  const annBuildMs = performance.now() - tAnn;
  let annotationLayer: AnnotationLayer | undefined;
  let layerInitMs = 0;
  if (opts.annotationsPerFrame > 0) {
    annotationLayer = createAnnotationLayer(opts.layer, overlay, byFrame);
    const t = performance.now();
    await annotationLayer.init();
    layerInitMs = performance.now() - t;
  }

  const recorder = new Recorder();
  const renderMs: number[] = [];
  const drawMs: number[] = [];
  viewer.addHandler('update-viewport', () => recorder.log('img', drawnFrame(viewer)));
  // Only when there is an annotation layer: with none, there is nothing to be coherent with.
  if (annotationLayer) {
    const layer = annotationLayer;
    overlay.canvas.on('after:render', () => recorder.log('ann', layer.current));
  }

  // CPU time of each Fabric render and each OSD world draw.
  const canvas = overlay.canvas;
  const origRender = canvas.renderAll.bind(canvas);
  canvas.renderAll = () => {
    const t = performance.now();
    origRender();
    if (recorder.recording) renderMs.push(performance.now() - t);
  };
  const world = viewer.world as unknown as { draw: () => void };
  const origDraw = world.draw.bind(world);
  world.draw = () => {
    const t = performance.now();
    origDraw();
    if (recorder.recording) drawMs.push(performance.now() - t);
  };

  session = {
    opts,
    viewer,
    overlay,
    decorationLayer,
    strategy,
    annotationLayer,
    byFrame,
    source,
    recorder,
    providers: opts.decorations
      ? [
          createMeasurementProvider<OsdFields>({ area: true, perimeter: true, length: true }),
          createLabelProvider<OsdFields>(),
        ]
      : [],
    applyTimings: [],
    renderMs,
    drawMs,
    consoleErrors,
    current: 0,
    initialZoom: viewer.viewport.getZoom(true),
  };
  apply(0);
  await annotationLayer?.settled();
  await waitFrames(5);
  return roundDeep({
    totalMs: performance.now() - tStart,
    genMs,
    convertMs,
    pngMs,
    openMs,
    annBuildMs,
    layerInitMs,
    pixelBytes: bytes,
    annotations: byFrame.reduce((s, a) => s + a.length, 0),
    drawer: (viewer.drawer as unknown as { getType(): string }).getType(),
    worldItems: viewer.world.getItemCount(),
    jsHeapMB: jsHeapMB(),
  });
}

function jsHeapMB(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
}

function apply(index: number): void {
  const s = session;
  if (!s) return;
  s.recorder.log('apply', index);
  const t0 = performance.now();
  s.strategy.show(index);
  const t1 = performance.now();
  s.annotationLayer?.show(index);
  const t2 = performance.now();
  if (s.decorationLayer && s.providers.length > 0) {
    const ctx = {
      annotations: s.byFrame[index] ?? [],
      pixelSpacing: { x: 0.7, y: 0.7, unit: 'mm' },
      selectedAnnotationId: null,
    };
    s.decorationLayer.setDecorations(s.providers.flatMap((p) => p(ctx)));
  }
  const t3 = performance.now();
  if (s.recorder.recording) s.applyTimings.push({ image: t1 - t0, ann: t2 - t1, deco: t3 - t2 });
  s.current = index;
}

/** Overlay exactness: Fabric's transform vs. the one OSD's viewport implies now, and zoom drift. */
function syncCheck(s: Session): Record<string, number> {
  const expected = computeViewportTransform(s.viewer);
  const actual = s.overlay.canvas.viewportTransform;
  let maxAbs = 0;
  for (let i = 0; i < 6; i++)
    maxAbs = Math.max(maxAbs, Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)));
  const zoom = s.viewer.viewport.getZoom(true);
  return { vptMaxAbsDiff: maxAbs, zoomRelDrift: Math.abs(zoom - s.initialZoom) / s.initialZoom };
}

function report(s: Session, extra: Record<string, unknown>): Record<string, unknown> {
  const a = analyzeDisplayLog(s.recorder.events);
  const t = s.applyTimings;
  return roundDeep({
    ...extra,
    frames: a.frames,
    applies: a.applies,
    delivered: a.delivered,
    superseded: a.superseded,
    distinctImageFrames: a.distinctImageFrames,
    imageChanges: a.imageChanges,
    slicesShown: a.slicesShown,
    blankFrames: a.blankFrames,
    mixedFrames: a.mixedFrames,
    incoherentFrames: a.incoherentFrames,
    latencyMs: summarize(a.latencyMs),
    latencyFrames: summarize(a.latencyFrames),
    applyImageMs: summarize(t.map((x) => x.image)),
    applyAnnMs: summarize(t.map((x) => x.ann)),
    applyDecoMs: summarize(t.map((x) => x.deco)),
    fabricRenderMs: summarize(s.renderMs),
    osdDrawMs: summarize(s.drawMs),
    paintMsPerFrame: s.source.paints > 0 ? s.source.paintMs / s.source.paints : 0,
    consoleErrors: s.consoleErrors.count,
    sync: syncCheck(s),
    jsHeapMB: jsHeapMB(),
  });
}

function startRecording(s: Session): void {
  s.recorder.reset();
  s.applyTimings.length = 0;
  s.renderMs.length = 0;
  s.drawMs.length = 0;
  s.source.paintMs = 0;
  s.source.paints = 0;
  s.recorder.recording = true;
}

/** Sequential single steps with idle gaps: pure per-slice latency, no overlap. */
async function latency(opts: {
  steps: number;
  idleFrames?: number;
}): Promise<Record<string, unknown>> {
  const s = need();
  startRecording(s);
  for (let k = 0; k < opts.steps; k++) {
    apply(stepFrameIndex(s.current, 1, s.opts.frames, true));
    await s.annotationLayer?.settled();
    await waitFrames(opts.idleFrames ?? 4);
  }
  await waitFrames(3);
  s.recorder.recording = false;
  return report(s, { mode: 'latency', steps: opts.steps });
}

/**
 * Scripted wheel scroll: synthetic WheelEvents at `rate` per second on the
 * cell (not OSD's canvas, so OSD does not zoom), ping-ponging at the stack
 * ends. Two scheduling policies:
 *
 * - `latest`: apply the newest target once per display frame (rAF-coalesced),
 *   whether or not the previous frame has been drawn yet. What a reactive
 *   binding does naturally.
 * - `await-drawn`: never start a new frame until OSD has drawn the previous
 *   one; then jump straight to the newest target. The sane policy for a
 *   strategy whose frames arrive asynchronously (a re-open, a re-fetch).
 */
async function scroll(opts: {
  rate: number;
  durationMs: number;
  policy?: 'latest' | 'await-drawn';
}): Promise<Record<string, unknown>> {
  const s = need();
  const policy = opts.policy ?? 'latest';
  const probe = new FrameRateProbe();
  let target = s.current;
  let dir = 1;
  let scheduled = false;
  let awaiting: number | undefined;
  let wheelEvents = 0;
  const applyTarget = (): void => {
    if (target === s.current) return;
    if (policy === 'await-drawn') awaiting = target;
    apply(target);
  };
  const onDrawn = (): void => {
    if (awaiting === undefined || drawnFrame(s.viewer) !== awaiting) return;
    awaiting = undefined;
    // Right after the draw, inside OSD's frame: the next one can be drawn at
    // the very next paint.
    queueMicrotask(applyTarget);
  };
  if (policy === 'await-drawn') s.viewer.addHandler('update-viewport', onDrawn);
  const onWheel = (e: WheelEvent): void => {
    wheelEvents++;
    const next = target + (e.deltaY > 0 ? dir : -dir);
    if (next < 0 || next >= s.opts.frames) dir = -dir;
    target = stepFrameIndex(target, dir, s.opts.frames, false);
    if (scheduled || awaiting !== undefined) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (awaiting === undefined) applyTarget();
    });
  };
  cell.addEventListener('wheel', onWheel, { passive: true });
  startRecording(s);
  probe.start();
  const interval = 1000 / opts.rate;
  const start = performance.now();
  let sent = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const due = Math.min(
        Math.floor((now - start) / interval) + 1,
        Math.ceil(opts.durationMs / interval),
      );
      while (sent < due) {
        cell.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
        sent++;
      }
      if (now - start >= opts.durationMs) resolve();
      else setTimeout(tick, Math.max(0, start + sent * interval - performance.now()));
    };
    tick();
  });
  const elapsed = performance.now() - start;
  await waitFrames(4);
  const intervals = probe.stop();
  s.recorder.recording = false;
  cell.removeEventListener('wheel', onWheel);
  s.viewer.removeHandler('update-viewport', onDrawn);
  const r = report(s, {
    mode: 'scroll',
    policy,
    rate: opts.rate,
    durationMs: elapsed,
    wheelEvents,
  });
  const a = analyzeDisplayLog(s.recorder.events);
  return {
    ...r,
    ...roundDeep({
      displayFps: (intervals.length / elapsed) * 1000,
      frameIntervalMs: summarize(intervals),
      longFrames: intervals.filter((x) => x > 25).length,
      /** New slices actually shown per second (blank flashes excluded): the scroll rate the user sees. */
      shownSlicesPerSec: (a.slicesShown / elapsed) * 1000,
    }),
  };
}

/**
 * Pixel-truth check: after each step, read back the frame barcode from OSD's
 * output canvas and compare with the frame the strategy claims it drew.
 */
async function verify(opts: { steps: number }): Promise<Record<string, unknown>> {
  const s = need();
  const out = s.viewer.drawer.canvas as HTMLCanvasElement;
  const ctx = out.getContext('2d');
  if (!ctx) return { error: 'drawer canvas has no 2d context' };
  const results: { expected: number; decoded: number; tagged: number }[] = [];
  const handler = (): void => {
    const ratio = OpenSeadragon.pixelDensityRatio;
    const samples: number[] = [];
    for (let b = 0; b <= MARKER_BITS; b++) {
      const c = markerBlockCenter(b);
      const p = s.viewer.viewport.imageToViewerElementCoordinates(
        new OpenSeadragon.Point(c.x, c.y),
      );
      const px = ctx.getImageData(Math.round(p.x * ratio), Math.round(p.y * ratio), 1, 1).data;
      samples.push(((px[0] ?? 0) + (px[1] ?? 0) + (px[2] ?? 0)) / 3);
    }
    results.push({
      expected: s.current,
      decoded: decodeFrameMarker(samples),
      tagged: drawnFrame(s.viewer),
    });
  };
  s.viewer.addHandler('update-viewport', handler);
  const checks: { expected: number; decoded: number; tagged: number }[] = [];
  for (let k = 0; k < opts.steps; k++) {
    apply(stepFrameIndex(s.current, 7, s.opts.frames, true));
    await waitFrames(8);
    const last = results[results.length - 1];
    if (last) checks.push(last);
  }
  s.viewer.removeHandler('update-viewport', handler);
  const wrong = checks.filter((c) => c.decoded !== c.expected);
  const tagLies = checks.filter((c) => c.tagged === c.expected && c.decoded !== c.expected);
  return {
    checked: checks.length,
    pixelMismatches: wrong.length,
    tagSaysRightPixelsWrong: tagLies.length,
    sample: wrong.slice(0, 5),
  };
}

function need(): Session {
  if (!session) throw new Error('call setup() first');
  return session;
}

async function teardown(): Promise<void> {
  const s = session;
  session = undefined;
  if (!s) return;
  s.annotationLayer?.dispose();
  s.decorationLayer?.destroy();
  s.overlay.destroy();
  s.strategy.dispose();
  s.viewer.destroy();
  if (s.source instanceof BitmapFrameStore) s.source.close();
  cell.innerHTML = '';
  urlFrames.clear();
  await sleep(50);
}

/** rAF baseline with nothing on the page doing work. */
async function baseline(durationMs: number): Promise<Record<string, unknown>> {
  const probe = new FrameRateProbe();
  probe.start();
  await sleep(durationMs);
  const intervals = probe.stop();
  return roundDeep({
    displayFps: (intervals.length / durationMs) * 1000,
    frameIntervalMs: summarize(intervals),
  });
}

function env(): Record<string, unknown> {
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: window.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    webgl2Renderer: gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    webCodecs: typeof VideoDecoder !== 'undefined',
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  };
}

declare global {
  interface Window {
    __poc: unknown;
  }
}

window.__poc = {
  ready: true,
  env,
  baseline,
  setup,
  latency,
  scroll,
  verify,
  teardown,
  cine: (opts: CineOptions) => runCine(cell, opts),
  /** Objects currently on the Fabric canvas (sanity). */
  objectCount: () =>
    need()
      .overlay.canvas.getObjects()
      .filter((o: FabricObject) => o.id).length,
};
