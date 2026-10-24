/**
 * The Solid binding under test: the real <AnnotatorProvider> + <ViewerCell>
 * (from @osdlabel/solid's built dist) showing a 300-slice stack with
 * per-slice annotations and live decorations, in one of three models:
 *
 * - `frame-axis` (the PoC): ONE FramedImageSource, annotations carry `frame`.
 * - `slice-ids` (the alternative on equal footing): the SAME FramedImageSource
 *   and FramePresenter, plus a series grouping `sliceImageIds` (one ImageId
 *   per slice). Annotations live in `byImage[sliceId]` with no `frame`; the
 *   grid holds one assignment (the series id); the view is kept.
 * - `reopen-per-slice` (a reference, not a model): today's binding path for
 *   N independent images, where the host re-assigns the cell's image per
 *   wheel notch and ViewerCell re-opens the viewer each time.
 *
 * In the first two, a wheel over the cell goes through the binding's own
 * path: capture listener -> stepCellFrame -> STEP_CELL_FRAME -> frame
 * throttle -> presenter + annotation rebuild + decoration effects. Rendering
 * choices (OSD drawer, Fabric object caching, object reuse) are set through
 * the provider's public `frameCellOptions`, not through globals.
 */
import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import { AnnotatorProvider, ViewerCell, createFrameThrottle, useAnnotator } from '@osdlabel/solid';
import type {
  AnnotationContextId,
  FrameCellOptions,
  OsdAnnotation,
  OsdFields,
  ImageId,
} from '@osdlabel/solid';
import type { AnnotationContext, CountScope } from '@osdlabel/annotation-context';
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

type Model = 'frame-axis' | 'slice-ids' | 'reopen-per-slice';

interface SolidSetup {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly annotationsPerFrame: number;
  readonly model?: Model;
  /** `frameCellOptions` for the stack cell (provider prop). Unset: the binding's defaults. */
  readonly frameCellOptions?: FrameCellOptions;
  /**
   * `reopen-per-slice` only (its cells show single-frame images, so
   * `frameCellOptions` does not apply): OSD drawer and Fabric object caching
   * forced through globals, as the earlier harness did for every model.
   */
  readonly referenceDrawer?: 'webgl' | 'canvas';
  readonly referenceObjectCaching?: boolean;
  /** Decoration providers on (default) or off. */
  readonly decorations?: boolean;
  /**
   * A per-slice limit on rectangles ('per-frame' scope for frame-axis,
   * 'per-image' on the slice id for slice-ids), so the constraint memo
   * recounts on every step as a labelling protocol would make it.
   */
  readonly perSliceLimit?: boolean;
}

const root = document.getElementById('root') as HTMLDivElement;
const recorder = new Recorder();
const handlerMs: number[] = [];
let viewer: OpenSeadragon.Viewer | undefined;
let overlay: FabricOverlay | undefined;
let annotated = false;
let frameCount = 0;
let model: Model = 'frame-axis';
let resetFrame: () => void = () => {};
let rotateCell: () => void = () => {};
let cellRotation: () => number = () => 0;
let currentFrame: () => number = () => 0;
/** Builds an annotation on `frame`; `add` and the `undo` it returns write the store. */
let prepareEdit: (frame: number, ordinal: number) => { add: () => () => void } = () => ({
  add: () => () => {},
});

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
  model = opts.model ?? 'frame-axis';
  const reopen = model === 'reopen-per-slice';
  if (reopen) {
    // The reference path's cells show plain images, which `frameCellOptions`
    // does not cover; it keeps the earlier harness's globals.
    (OpenSeadragon.DEFAULT_SETTINGS as unknown as { drawer: string }).drawer =
      opts.referenceDrawer ?? 'canvas';
    for (const C of [Rect, Circle, Line, Polyline, Polygon]) {
      (C as unknown as { ownDefaults: Record<string, unknown> }).ownDefaults['objectCaching'] =
        opts.referenceObjectCaching ?? false;
    }
  }
  frameCount = opts.frames;
  const t0 = performance.now();
  const gray = renderCtStack(opts.frames, opts.width, opts.height);
  const store = new Gray8FrameStore(opts.width, opts.height, opts.frames, gray);
  const seriesId: ImageId = createImageId('ct-series');
  const contextId: AnnotationContextId = createAnnotationContextId('ctx');
  const keys = Array.from({ length: opts.frames }, (_, i) => `1.2.840.99999.${i + 1}`);
  // The alternative's slice ids are the slices' own UIDs: stable keys, no
  // reconciliation step when the axis is reordered.
  const sliceIds = keys.map((k) => createImageId(k));
  const pixelSpacing = { x: 0.7, y: 0.7, unit: 'mm' };
  const source: FramedImageSource = {
    id: seriesId,
    tileSource: '',
    label: 'CT phantom',
    pixelSpacing,
    frameAxis: { kind: 'spatial', count: opts.frames, keys },
    frameSource: store,
    ...(model === 'slice-ids' ? { sliceImageIds: sliceIds } : {}),
  };
  const sliceSources = new Map<ImageId, ImageSource>(
    reopen
      ? sliceIds.map((id, i) => [
          id,
          {
            id,
            pixelSpacing,
            // Best case for this path: no network, no decode — the same pixels
            // the presenter paints, through one tile source per slice.
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
        ])
      : [],
  );
  /** Where model `model` keeps an annotation placed on `frame`. */
  const place = (framed: OsdAnnotation, frame: number): OsdAnnotation => {
    if (model === 'frame-axis') return framed;
    const a: OsdAnnotation = { ...framed, imageId: sliceIds[frame]! };
    delete (a as { frame?: unknown }).frame;
    return a;
  };
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
      const a = place(buildAnnotation(spec, seriesId, contextId, keys[f]), f);
      (byImage[a.imageId] ??= {})[a.id] = a;
    }
  }
  annotated = opts.annotationsPerFrame > 0;
  const genMs = performance.now() - t0;

  const countScope: CountScope = model === 'frame-axis' ? 'per-frame' : 'per-image';
  const context: AnnotationContext = {
    id: contextId,
    label: 'Lesions',
    tools: [
      opts.perSliceLimit
        ? { type: 'rectangle', maxCount: 10_000, countScope }
        : { type: 'rectangle' },
    ],
  };

  let ready!: () => void;
  const mounted = new Promise<void>((r) => (ready = r));
  const Harness = () => {
    const { actions, uiState } = useAnnotator();
    let slice = 0;
    const throttle = createFrameThrottle<number>((i) => actions.assignImageToCell(0, sliceIds[i]!));
    resetFrame = reopen
      ? () => {
          slice = 0;
          actions.assignImageToCell(0, sliceIds[0]!);
        }
      : () => actions.setCellFrame(0, 0, opts.frames, ...(model === 'slice-ids' ? [sliceIds] : []));
    rotateCell = () => actions.rotateActiveImageCW();
    cellRotation = () => uiState.cellTransforms[0]?.rotation ?? 0;
    currentFrame = () =>
      reopen
        ? sliceIds.indexOf(uiState.gridAssignments[0]!)
        : (uiState.cellFrames?.[0]?.index ?? 0);
    prepareEdit = (frame, ordinal) => {
      const spec = fixtureGeometry(frame, 1, opts.width, opts.height)[0]!;
      const a = place(
        buildAnnotation({ ...spec, ordinal }, seriesId, contextId, keys[frame]),
        frame,
      );
      return {
        add: () => {
          actions.addAnnotation(a);
          return () => actions.deleteAnnotation(a.id, a.imageId);
        },
      };
    };
    onMount(() => {
      actions.setContexts([context]);
      actions.setActiveContext(contextId);
      actions.assignImageToCell(0, reopen ? sliceIds[0]! : seriesId);
      if (reopen) {
        // What a host has to write for this path: its own wheel handling,
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
      reopen ? sliceSources.get(uiState.gridAssignments[0]!) : source;
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
        frameCellOptions={opts.frameCellOptions}
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
  const firstAnnotation = overlay!.canvas.getObjects().find((o) => o.id);
  return roundDeep({
    genMs,
    mountMs,
    model,
    annotations: Object.values(byImage).reduce((n, b) => n + Object.keys(b).length, 0),
    imageBuckets: Object.keys(byImage).length,
    drawer: (viewer!.drawer as unknown as { getType(): string }).getType(),
    objectCachingEffective: firstAnnotation ? firstAnnotation.objectCaching : null,
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
 * binding's — or the host's — capture listener first). A pass starts at frame
 * 0 and walks forward, bouncing at the ends of `[0, window)` (default: the
 * whole axis); every pass of the same length visits the same frames.
 * `record: false` runs it unmeasured (to prime a window).
 */
async function scroll(opts: {
  rate: number;
  durationMs: number;
  window?: number;
  record?: boolean;
}): Promise<Record<string, unknown>> {
  const target = viewer!.canvas;
  const span = Math.max(2, Math.min(frameCount, opts.window ?? frameCount));
  const record = opts.record ?? true;
  resetFrame();
  await waitFrames(3);
  if (record) startRecording();
  const interval = 1000 / opts.rate;
  const start = performance.now();
  let sent = 0;
  let dir = 1;
  let pos = 0;
  const visited = new Set<number>([0]);
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const due = Math.min(
        Math.floor((now - start) / interval) + 1,
        Math.ceil(opts.durationMs / interval),
      );
      while (sent < due) {
        if (pos + dir < 0 || pos + dir >= span) dir = -dir;
        pos += dir;
        visited.add(pos);
        // Solid effects run synchronously inside the wheel handler, so the
        // dispatch time is the binding's whole synchronous frame step.
        const t0 = performance.now();
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100 * dir, bubbles: true, cancelable: true }),
        );
        if (record) handlerMs.push(performance.now() - t0);
        sent++;
      }
      if (now - start >= opts.durationMs) resolve();
      else setTimeout(tick, Math.max(0, start + sent * interval - performance.now()));
    };
    tick();
  });
  if (!record) {
    await waitFrames(4);
    return { wheelEvents: sent, framesVisited: visited.size };
  }
  return {
    ...(await stopRecording()),
    wheelEvents: sent,
    rate: opts.rate,
    window: span,
    framesVisited: visited.size,
  };
}

/**
 * The binding's synchronous cost of one annotation edit on the shown frame:
 * `addAnnotation` then `deleteAnnotation`, each timed around the store write
 * (Solid runs the dependent memos and effects inside it). Frame-axis rebuilds
 * its per-frame bucket index over the whole series on every edit; a series
 * grouping keyed by slice id touches one slice's bucket.
 */
async function editProbe(reps = 11): Promise<Record<string, unknown>> {
  const frame = currentFrame();
  const add: number[] = [];
  const del: number[] = [];
  for (let r = 0; r < reps; r++) {
    const edit = prepareEdit(frame, 9000 + r);
    const t0 = performance.now();
    const undo = edit.add();
    add.push(performance.now() - t0);
    await waitFrames(2);
    const t1 = performance.now();
    undo();
    del.push(performance.now() - t1);
    await waitFrames(2);
  }
  return roundDeep({ frame, addMs: summarize(add), deleteMs: summarize(del) });
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
  editProbe,
  /** The last recording's display log, for diagnostics (scripts/coherence.mjs). */
  displayLog: () => ({ raw: recorder.raw, events: recorder.events }),
  /** Objects on the Fabric canvas: annotations (with an id) and the rest (decoration lines). */
  objectCount: () => {
    const objs = overlay?.canvas.getObjects() ?? [];
    return { withId: objs.filter((o) => o.id).length, total: objs.length };
  },
};
