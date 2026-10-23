/**
 * The Solid binding under test: the real <AnnotatorProvider> + <ViewerCell>
 * (from @osdlabel/solid's built dist) showing a 300-slice FramedImageSource
 * with per-slice annotations and live decorations. A wheel over the cell goes
 * through the binding's own path: capture listener -> stepCellFrame ->
 * STEP_CELL_FRAME -> the presenter effect + the annotation rebuild effect +
 * the decoration effect.
 */
import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import { AnnotatorProvider, ViewerCell, useAnnotator } from '@osdlabel/solid';
import type { AnnotationContextId, OsdAnnotation, OsdFields, ImageId } from '@osdlabel/solid';
import type { FramedImageSource } from '@osdlabel/frame-osd';
import OpenSeadragon from 'openseadragon';
import { Circle, Line, Polygon, Polyline, Rect } from 'fabric';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import { createLabelProvider, createMeasurementProvider } from '@osdlabel/decoration';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { lesionsOnSlice, renderCtStack } from '../data/ct-phantom.js';
import { Gray8FrameStore } from '../data/frame-stores.js';
import { fixtureGeometry } from '../annotations/fixtures.js';
import { buildAnnotation } from '../annotations/layers.js';
import { canvasTag, FrameRateProbe, Recorder, sleep, waitFrames } from '../instrument/recorder.js';
import { analyzeDisplayLog } from '../instrument/display-log.js';
import { roundDeep, summarize } from '../instrument/stats.js';

interface SolidSetup {
  /** OSD drawer. ViewerCell exposes no viewer options, so this sets OSD's global default. */
  readonly drawer?: 'webgl' | 'canvas';
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly annotationsPerFrame: number;
  /**
   * Fabric per-object render caching for the vector shapes (Fabric default:
   * on). A host-level class default, so the binding itself is unchanged.
   */
  readonly objectCaching?: boolean;
  /** Decoration providers on (default) or off. */
  readonly decorations?: boolean;
}

const root = document.getElementById('root') as HTMLDivElement;
const recorder = new Recorder();
const handlerMs: number[] = [];
let viewer: OpenSeadragon.Viewer | undefined;
let overlay: FabricOverlay | undefined;
let annotated = false;

function drawnFrame(): number {
  if (!viewer) return -1;
  const item = viewer.world.getItemAt(0) as unknown as
    | { getTilesToDraw(): { tile: { getCanvasContext?: () => CanvasRenderingContext2D | null } }[] }
    | undefined;
  const t = item?.getTilesToDraw()[0];
  return canvasTag(t?.tile.getCanvasContext?.()?.canvas) ?? -1;
}

/** Frame whose annotations are on the canvas, from the fixture ids (`f<frame>-a<n>`); -1 if none. */
function annotationFrame(): number {
  const objs = overlay?.canvas.getObjects() ?? [];
  for (const o of objs) {
    const m = typeof o.id === 'string' ? /^f(\d+)-a/.exec(o.id) : null;
    if (m) return Number(m[1]);
  }
  return -1;
}

async function setup(opts: SolidSetup): Promise<Record<string, unknown>> {
  (OpenSeadragon.DEFAULT_SETTINGS as unknown as { drawer: string }).drawer = opts.drawer ?? 'webgl';
  for (const C of [Rect, Circle, Line, Polyline, Polygon]) {
    (C as unknown as { ownDefaults: Record<string, unknown> }).ownDefaults['objectCaching'] =
      opts.objectCaching ?? true;
  }
  const t0 = performance.now();
  const gray = renderCtStack(opts.frames, opts.width, opts.height);
  const store = new Gray8FrameStore(opts.width, opts.height, opts.frames, gray);
  const imageId: ImageId = createImageId('ct-series');
  const contextId: AnnotationContextId = createAnnotationContextId('ctx');
  const keys = Array.from({ length: opts.frames }, (_, i) => `1.2.840.99999.${i + 1}`);
  const source: FramedImageSource = {
    id: imageId,
    tileSource: '',
    label: 'CT phantom',
    pixelSpacing: { x: 0.7, y: 0.7, unit: 'mm' },
    frameAxis: { kind: 'spatial', count: opts.frames, keys },
    frameSource: store,
  };
  const byFrame: Record<string, OsdAnnotation> = {};
  if (opts.annotationsPerFrame > 0) {
    for (let f = 0; f < opts.frames; f++) {
      const specs = fixtureGeometry(
        f,
        opts.annotationsPerFrame,
        opts.width,
        opts.height,
        lesionsOnSlice(f, opts.frames, opts.width, opts.height),
      );
      for (const spec of specs) {
        const a = buildAnnotation(spec, imageId, contextId, keys[f]);
        byFrame[a.id] = a;
      }
    }
  }
  annotated = opts.annotationsPerFrame > 0;
  const genMs = performance.now() - t0;

  let ready!: () => void;
  const mounted = new Promise<void>((r) => (ready = r));
  const Harness = () => {
    const { actions } = useAnnotator();
    onMount(() => {
      actions.setContexts([{ id: contextId, label: 'Lesions', tools: [{ type: 'rectangle' }] }]);
      actions.setActiveContext(contextId);
      actions.assignImageToCell(0, imageId);
    });
    return (
      <ViewerCell
        imageSource={source}
        isActive={true}
        cellIndex={0}
        onActivate={() => {}}
        onOverlayReady={(ov) => {
          overlay = ov;
          viewer = (ov.overlayElement as unknown as { __osdViewer: OpenSeadragon.Viewer })
            .__osdViewer;
          ready();
        }}
      />
    );
  };
  const tMount = performance.now();
  render(
    () => (
      <AnnotatorProvider
        initialAnnotations={
          { [imageId]: byFrame } as Record<ImageId, Record<string, OsdAnnotation>>
        }
        decorationProviders={
          opts.decorations === false
            ? []
            : [
                createMeasurementProvider<OsdFields>({ area: true, perimeter: true, length: true }),
                createLabelProvider<OsdFields>(),
              ]
        }
        testMode={true}
      >
        <Harness />
      </AnnotatorProvider>
    ),
    root,
  );
  await mounted;
  const mountMs = performance.now() - tMount;
  viewer!.addHandler('update-viewport', () => recorder.log('img', drawnFrame()));
  if (annotated) overlay!.canvas.on('after:render', () => recorder.log('ann', annotationFrame()));
  await sleep(300);
  await waitFrames(5);
  return roundDeep({
    genMs,
    mountMs,
    annotations: Object.keys(byFrame).length,
    drawer: (viewer!.drawer as unknown as { getType(): string }).getType(),
    objectCachingEffective: new Rect().objectCaching,
  });
}

let probe: FrameRateProbe | undefined;
let recordStart = 0;

function startRecording(): void {
  recorder.reset();
  handlerMs.length = 0;
  recorder.recording = true;
  probe = new FrameRateProbe();
  probe.start();
  recordStart = performance.now();
}

async function stopRecording(): Promise<Record<string, unknown>> {
  await waitFrames(4);
  const elapsed = performance.now() - recordStart;
  recorder.recording = false;
  const intervals = probe?.stop() ?? [];
  const a = analyzeDisplayLog(recorder.events);
  return roundDeep({
    durationMs: elapsed,
    displayFps: (intervals.length / elapsed) * 1000,
    frameIntervalMs: summarize(intervals),
    longFrames: intervals.filter((x) => x > 25).length,
    shownSlicesPerSec: (a.slicesShown / elapsed) * 1000,
    distinctImageFrames: a.distinctImageFrames,
    blankFrames: a.blankFrames,
    incoherentFrames: a.incoherentFrames,
    frames: a.frames,
    applyMs: summarize(handlerMs),
    jsHeapMB:
      ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
        0) / 1048576,
  });
}

/** Synthetic wheel at `rate`/s dispatched on OSD's canvas, through the binding's capture listener. */
async function scroll(opts: {
  rate: number;
  durationMs: number;
}): Promise<Record<string, unknown>> {
  const target = viewer!.canvas;
  startRecording();
  const interval = 1000 / opts.rate;
  const start = performance.now();
  let sent = 0;
  let dir = 1;
  let pos = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const due = Math.min(
        Math.floor((now - start) / interval) + 1,
        Math.ceil(opts.durationMs / interval),
      );
      while (sent < due) {
        if (pos + dir < 0 || pos + dir >= 300) dir = -dir;
        pos += dir;
        // Solid effects run synchronously inside the binding's wheel handler,
        // so the dispatch time is the binding's whole synchronous frame step.
        const t0 = performance.now();
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100 * dir, bubbles: true, cancelable: true }),
        );
        handlerMs.push(performance.now() - t0);
        sent++;
      }
      if (now - start >= opts.durationMs) resolve();
      else setTimeout(tick, Math.max(0, start + sent * interval - performance.now()));
    };
    tick();
  });
  return { ...(await stopRecording()), wheelEvents: sent, rate: opts.rate };
}

declare global {
  interface Window {
    __poc: unknown;
  }
}

window.__poc = { ready: true, setup, startRecording, stopRecording, scroll };
