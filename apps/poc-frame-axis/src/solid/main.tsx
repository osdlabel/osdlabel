/**
 * The Solid binding under test: the real <AnnotatorProvider> + <ViewerCell>
 * (from @osdlabel/solid's built dist) showing a 300-slice stack with
 * per-slice annotations and live decorations, in either model:
 *
 * - `frame-axis` (the PoC): ONE FramedImageSource, annotations carry `frame`.
 *   A wheel over the cell goes through the binding's own path: capture
 *   listener -> stepCellFrame -> STEP_CELL_FRAME -> frame throttle -> the
 *   presenter effect + the annotation rebuild effect + the decoration effect.
 * - `image-per-slice` (the alternative): one ImageSource and ImageId per
 *   slice; navigation re-assigns the cell's image, through wheel handling the
 *   host has to write itself (below).
 */
import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import { AnnotatorProvider, ViewerCell, createFrameThrottle, useAnnotator } from '@osdlabel/solid';
import type { AnnotationContextId, OsdAnnotation, OsdFields, ImageId } from '@osdlabel/solid';
import type { FramedImageSource } from '@osdlabel/frame-osd';
import { createCanvasTileSource, createFrameCanvas } from '@osdlabel/frame-osd';
import type { ImageSource } from '@osdlabel/viewer-api';
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
  readonly model?: 'frame-axis' | 'image-per-slice';
}

const root = document.getElementById('root') as HTMLDivElement;
const recorder = new Recorder();
const handlerMs: number[] = [];
let viewer: OpenSeadragon.Viewer | undefined;
let overlay: FabricOverlay | undefined;
let annotated = false;
let frameCount = 0;
let resetFrame: () => void = () => {};
let rotateCell: () => void = () => {};
let cellRotation: () => number = () => 0;

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
  frameCount = opts.frames;
  const perSlice = opts.model === 'image-per-slice';
  const t0 = performance.now();
  const gray = renderCtStack(opts.frames, opts.width, opts.height);
  const store = new Gray8FrameStore(opts.width, opts.height, opts.frames, gray);
  const imageId: ImageId = createImageId('ct-series');
  const contextId: AnnotationContextId = createAnnotationContextId('ctx');
  const keys = Array.from({ length: opts.frames }, (_, i) => `1.2.840.99999.${i + 1}`);
  const pixelSpacing = { x: 0.7, y: 0.7, unit: 'mm' };
  const source: FramedImageSource = {
    id: imageId,
    tileSource: '',
    label: 'CT phantom',
    pixelSpacing,
    frameAxis: { kind: 'spatial', count: opts.frames, keys },
    frameSource: store,
  };
  const sliceIds = Array.from({ length: opts.frames }, (_, i) => createImageId(`slice-${i}`));
  const sliceSources = new Map<ImageId, ImageSource>(
    sliceIds.map((id, i) => [
      id,
      {
        id,
        pixelSpacing,
        // Best case for this model: no network, no decode — the same pixels
        // the frame-axis presenter paints, through one tile source per slice.
        tileSource: createCanvasTileSource({
          width: opts.width,
          height: opts.height,
          cacheKey: `slice-${i}`,
          provide: () => {
            const ctx = createFrameCanvas(opts.width, opts.height);
            store.paint(i, ctx);
            return ctx;
          },
        }),
      },
    ]),
  );
  const byImage: Record<string, Record<string, OsdAnnotation>> = {};
  for (let f = 0; f < opts.frames && opts.annotationsPerFrame > 0; f++) {
    const specs = fixtureGeometry(
      f,
      opts.annotationsPerFrame,
      opts.width,
      opts.height,
      lesionsOnSlice(f, opts.frames, opts.width, opts.height),
    );
    for (const spec of specs) {
      const framed = buildAnnotation(spec, imageId, contextId, keys[f]);
      if (perSlice) {
        const a: OsdAnnotation = { ...framed, imageId: sliceIds[f]! };
        delete (a as { frame?: unknown }).frame;
        (byImage[sliceIds[f]!] ??= {})[a.id] = a;
      } else {
        (byImage[imageId] ??= {})[framed.id] = framed;
      }
    }
  }
  annotated = opts.annotationsPerFrame > 0;
  const genMs = performance.now() - t0;

  let ready!: () => void;
  const mounted = new Promise<void>((r) => (ready = r));
  const Harness = () => {
    const { actions, uiState } = useAnnotator();
    let slice = 0;
    const throttle = createFrameThrottle<number>((i) => actions.assignImageToCell(0, sliceIds[i]!));
    resetFrame = perSlice
      ? () => {
          slice = 0;
          actions.assignImageToCell(0, sliceIds[0]!);
        }
      : () => actions.setCellFrame(0, 0, opts.frames);
    rotateCell = () => actions.rotateActiveImageCW();
    cellRotation = () => uiState.cellTransforms[0]?.rotation ?? 0;
    onMount(() => {
      actions.setContexts([{ id: contextId, label: 'Lesions', tools: [{ type: 'rectangle' }] }]);
      actions.setActiveContext(contextId);
      actions.assignImageToCell(0, perSlice ? sliceIds[0]! : imageId);
      if (perSlice) {
        // What a host has to write for this model: its own wheel handling,
        // ahead of OSD (which would zoom), mapping notches to image ids.
        root.addEventListener(
          'wheel',
          (e) => {
            if (e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            slice = Math.max(0, Math.min(opts.frames - 1, slice + Math.sign(e.deltaY)));
            throttle.request(slice);
          },
          { capture: true, passive: false },
        );
      }
    });
    const current = (): ImageSource | undefined =>
      perSlice ? sliceSources.get(uiState.gridAssignments[0]!) : source;
    return (
      <ViewerCell
        imageSource={current()}
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
        initialAnnotations={byImage as Record<ImageId, Record<string, OsdAnnotation>>}
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
    model: perSlice ? 'image-per-slice' : 'frame-axis',
    annotations: Object.values(byImage).reduce((n, b) => n + Object.keys(b).length, 0),
    drawer: (viewer!.drawer as unknown as { getType(): string }).getType(),
    objectCachingEffective: new Rect().objectCaching,
  });
}

/**
 * Put the cell in a non-default view (rotated 90°, zoomed 2x) so a scroll
 * can show whether navigation keeps the user's view.
 */
async function prepareView(): Promise<Record<string, number>> {
  rotateCell();
  await waitFrames(2);
  const vp = viewer!.viewport;
  vp.zoomTo(vp.getHomeZoom() * 2, undefined, true);
  await waitFrames(3);
  return viewState();
}

function viewState(): Record<string, number> {
  const vp = viewer!.viewport;
  return roundDeep({
    rotation: cellRotation(),
    zoomOverHome: vp.getZoom(true) / vp.getHomeZoom(),
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

/**
 * Synthetic wheel at `rate`/s dispatched on OSD's canvas (so it passes the
 * binding's — or the host's — capture listener first). Every pass starts at
 * frame 0 and walks the same frames, so a second pass measures revisits.
 */
async function scroll(opts: {
  rate: number;
  durationMs: number;
}): Promise<Record<string, unknown>> {
  const target = viewer!.canvas;
  resetFrame();
  await waitFrames(3);
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
        if (pos + dir < 0 || pos + dir >= frameCount) dir = -dir;
        pos += dir;
        // Solid effects run synchronously inside the wheel handler, so the
        // dispatch time is the binding's whole synchronous frame step.
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

window.__poc = {
  ready: true,
  setup,
  startRecording,
  stopRecording,
  scroll,
  prepareView,
  viewState,
  /** Objects on the Fabric canvas: annotations (with an id) and the rest (decoration lines). */
  objectCount: () => {
    const objs = overlay?.canvas.getObjects() ?? [];
    return { withId: objs.filter((o) => o.id).length, total: objs.length };
  },
};
