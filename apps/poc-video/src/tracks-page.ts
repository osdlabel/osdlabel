/**
 * H3 harness: draw a box on one frame with the stock RectangleTool, move it
 * on a later frame with Fabric's own selection, scrub, and watch the
 * interpolation. Frames come from WebCodecsFrameSource (frame-exact) into
 * OSD through the one-tile canvas TileSource; annotations live in
 * @osdlabel/temporal tracks and are materialised per frame into ordinary
 * Fabric objects carrying the track id.
 *
 * Nothing in fabric-annotations or fabric-osd changes: the tool's
 * `addAnnotation` and Fabric's `object:modified` become keyframe upserts.
 *
 * `addDemoTracks()` adds what the mouse flow does not exercise: a polygon
 * whose keyframes differ in vertex count and winding (12 CCW -> 24 CW), with
 * an `outside` gap, and a brush mask (pixels from @osdlabel/mask) held at
 * the nearest keyframe. `setVisibility` marks a track occluded / outside
 * from the current frame on, the way an annotator would.
 */
import OpenSeadragon from 'openseadragon';
import type { FabricObject, TPointerEventInfo } from 'fabric';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import {
  RectangleTool,
  buildFabricObjectFromGeometry,
  buildMaskFabricObject,
  getFabricOptions,
  getGeometryFromFabricObject,
} from '@osdlabel/fabric-annotations';
import type { ToolCallbacks } from '@osdlabel/fabric-annotations';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_KEYBOARD_SHORTCUTS,
  getScenePointFromEvent,
  maskAnnotationFields,
  stampCircle,
} from 'osdlabel';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { DEFAULT_ANNOTATION_STYLE, toolTypeToGeometryType } from '@osdlabel/annotation';
import type { Geometry, MaskRawAnnotationData, Point } from '@osdlabel/annotation';
import {
  CorrespondenceCache,
  createTrack,
  createTrackId,
  sampleTrack,
  toTrackDocument,
  upsertKeyframe,
} from '@osdlabel/temporal';
import type { Keyframe, TrackBase, TrackSample, Visibility } from '@osdlabel/temporal';
import { createCanvasTileSource } from './lib/canvas-tile-source.js';
import { FrameProbe, loadManifest, mediaUrl } from './lib/manifest.js';
import { openFrameSource } from './lib/open-frame-source.js';

type Mode = 'rectangle' | 'select' | 'navigation';

/** Keyframe payload: a mask's pixels; vector tracks carry none. */
type Payload = MaskRawAnnotationData;

interface Shown {
  readonly obj: FabricObject;
  readonly geometry: Geometry;
  readonly payload: Payload | undefined;
  readonly baseOpacity: number;
}

/** Opacity multiplier for an occluded track. */
const OCCLUDED_OPACITY = 0.35;

interface ScrubResult {
  readonly frame: number;
  readonly shown: number;
  readonly ms: number;
  readonly objects: readonly {
    id: string;
    geometry: Geometry | null;
    visible: boolean;
    opacity: number;
    left: number;
    top: number;
  }[];
  readonly samples: readonly {
    id: string;
    source: TrackSample['source'] | null;
    visibility: TrackSample['visibility'] | null;
    /** Frame of the keyframe whose payload (mask pixels) the sample carries. */
    payloadFrame: number | null;
  }[];
}

/** Screen box of what the overlay actually painted for one track, vs where its geometry says. */
interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * What the overlay painted for one track, against two references: the box of
 * the Fabric object's own current corners (`getCoords`, so a stale object
 * cache shows up as `maxEdgeErrPx`), and the box the track's rectangle
 * geometry describes (`origin` = top-left; `geometryOffsetPx` measures how
 * far the stock builder's object is from it).
 */
interface RenderedBox {
  readonly painted: Box | null;
  readonly objectBox: Box;
  readonly geometryBox: Box;
  readonly maxEdgeErrPx: number;
  readonly geometryOffsetPx: number;
  readonly objectCaching: boolean;
  readonly originX: string;
}

function boxOf(points: readonly Point[]): Box {
  return {
    x0: Math.min(...points.map((c) => c.x)),
    y0: Math.min(...points.map((c) => c.y)),
    x1: Math.max(...points.map((c) => c.x)),
    y1: Math.max(...points.map((c) => c.y)),
  };
}

function maxEdgeDiff(a: Box, b: Box): number {
  return Math.max(
    Math.abs(a.x0 - b.x0),
    Math.abs(a.y0 - b.y0),
    Math.abs(a.x1 - b.x1),
    Math.abs(a.y1 - b.y1),
  );
}

function starPolygon(n: number, cx: number, cy: number, r: number, ccw: boolean): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? -1 : 1) * i * 2 * Math.PI) / n;
    const rr = r * (i % 2 === 0 ? 1 : 0.6);
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
  }
  return pts;
}

const params = new URLSearchParams(location.search);
const videoName = params.get('video') ?? 'h264-720p-30-g30-bf';

async function main(): Promise<void> {
  const v = (await loadManifest())[videoName];
  if (v === undefined) throw new Error(`unknown video ${videoName}`);
  const { source: src } = await openFrameSource(mediaUrl(v), {
    cacheFrames: 32,
    cacheBytes: 512 * 1024 ** 2,
  });
  const probe = new FrameProbe();
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = v.width;
  tileCanvas.height = v.height;
  const tileCtx = tileCanvas.getContext('2d')!;

  const viewer = OpenSeadragon({
    element: document.getElementById('viewer')!,
    drawer: 'canvas',
    showNavigationControl: false,
    immediateRender: true,
    tileSources: createCanvasTileSource(
      tileCanvas,
      v.width,
      v.height,
    ) as unknown as OpenSeadragon.TileSourceOptions,
  });
  await new Promise<void>((resolve) => viewer.addOnceHandler('open', () => resolve()));
  const overlay = new FabricOverlay(viewer, { testMode: true });
  const canvas = overlay.canvas;

  const imageId = createImageId(videoName);
  const contextId = createAnnotationContextId('video');
  let tracks: TrackBase<Payload>[] = [];
  /** The Fabric object shown for each track, and the sample it was last set from. */
  const objects = new Map<string, Shown>();
  const cache = new CorrespondenceCache();
  const counters = { inPlace: 0, rebuilt: 0, unchanged: 0 };
  let current = 0;

  const buildObject = (t: TrackBase<Payload>, s: TrackSample<Payload>): FabricObject | null => {
    if (s.geometry.type === 'mask') {
      return s.payload === undefined ? null : buildMaskFabricObject(s.payload, { id: t.id });
    }
    return buildFabricObjectFromGeometry(
      s.geometry,
      getFabricOptions(DEFAULT_ANNOTATION_STYLE, t.id),
    );
  };

  /**
   * Materialise every track on `current` into its Fabric object. A sample
   * identical to the last one (a held keyframe) touches nothing; a rectangle
   * is updated in place (object caching left at Fabric's default, so the
   * pixel check in `renderedBox` would catch a stale cache); other types are
   * rebuilt, because an interpolated contour can change its vertex count and
   * a held mask swaps its pixels.
   */
  const applyTracks = (): TrackSample<Payload>[] => {
    const out: TrackSample<Payload>[] = [];
    for (const t of tracks) {
      const s = sampleTrack(t, current, cache);
      const shown = objects.get(t.id);
      if (s === null) {
        shown?.obj.set({ visible: false });
        continue;
      }
      let obj: FabricObject;
      if (shown !== undefined && shown.geometry === s.geometry && shown.payload === s.payload) {
        obj = shown.obj;
        counters.unchanged++;
      } else if (shown !== undefined && s.geometry.type === 'rectangle') {
        obj = shown.obj;
        const fresh = buildObject(t, s)!;
        obj.set({
          left: fresh.left,
          top: fresh.top,
          width: fresh.width,
          height: fresh.height,
          angle: fresh.angle,
          scaleX: 1,
          scaleY: 1,
        });
        counters.inPlace++;
      } else {
        const fresh = buildObject(t, s);
        if (shown !== undefined) canvas.remove(shown.obj);
        if (fresh === null) {
          objects.delete(t.id);
          continue;
        }
        canvas.add(fresh);
        overlay.applyModeToObject(fresh, s.geometry.type === 'mask');
        obj = fresh;
        counters.rebuilt++;
      }
      const baseOpacity =
        shown !== undefined && shown.obj === obj ? shown.baseOpacity : (obj.opacity ?? 1);
      objects.set(t.id, { obj, geometry: s.geometry, payload: s.payload, baseOpacity });
      obj.set({
        visible: true,
        // Occluded: still tracked and interpolated, drawn faded.
        opacity: s.visibility === 'occluded' ? baseOpacity * OCCLUDED_OPACITY : baseOpacity,
      });
      if (s.geometry.type !== 'mask') {
        obj.set({ strokeDashArray: s.keyframe !== null ? null : [6, 4] });
      }
      obj.setCoords();
      out.push(s);
    }
    return out;
  };

  let pendingResolve: (() => void) | null = null;
  viewer.addHandler('update-viewport', () => {
    applyTracks();
    overlay.sync();
    const r = pendingResolve;
    pendingResolve = null;
    r?.();
  });

  const showFrameUi = (): void => {
    (document.getElementById('frame') as HTMLElement).textContent = `frame ${current}`;
    (document.getElementById('scrub') as HTMLInputElement).value = String(current);
    (document.getElementById('kfs') as HTMLElement).textContent = tracks
      .map((t) => `${t.id}: kf ${t.keyframes.map((k) => k.frame).join(',')}`)
      .join(' | ');
  };

  const scrub = async (frame: number): Promise<ScrubResult> => {
    const t0 = performance.now();
    const vf = await src.getFrame(frame);
    tileCtx.drawImage(vf, 0, 0, v.width, v.height);
    vf.close();
    current = frame;
    const drawn = new Promise<void>((r) => (pendingResolve = r));
    viewer.forceRedraw();
    await drawn;
    const ms = performance.now() - t0;
    showFrameUi();
    return {
      frame,
      shown: probe.read(tileCanvas, v).value,
      ms,
      objects: tracks.map((t) => {
        const o = objects.get(t.id)?.obj;
        return {
          id: t.id,
          geometry: o === undefined ? null : getGeometryFromFabricObject(o, t.geometryType),
          visible: o?.visible ?? false,
          opacity: o?.opacity ?? 0,
          left: o?.left ?? NaN,
          top: o?.top ?? NaN,
        };
      }),
      samples: tracks.map((t) => {
        const smp = sampleTrack(t, frame, cache);
        return {
          id: t.id,
          source: smp?.source ?? null,
          visibility: smp?.visibility ?? null,
          payloadFrame:
            smp?.payload === undefined
              ? null
              : (t.keyframes.find((k) => k.payload === smp.payload)?.frame ?? null),
        };
      }),
    };
  };

  // Editing an object on the current frame sets that track's keyframe there.
  canvas.on('object:modified', (e) => {
    const target = e.target;
    const id = target?.id;
    if (target === undefined || id === undefined) return;
    tracks = tracks.map((t) => {
      if (t.id !== id) return t;
      const g = getGeometryFromFabricObject(target, t.geometryType);
      const was = sampleTrack(t, current, cache);
      if (g === null) return t;
      // The object now shows the edited geometry, not the sample it was last
      // set from: record that, or a later return to that sample would be
      // taken for "unchanged" and leave the dragged object where it was.
      const shown = objects.get(t.id);
      if (shown !== undefined) objects.set(t.id, { ...shown, geometry: g });
      return upsertKeyframe(t, {
        frame: current,
        geometry: g,
        visibility: was?.visibility ?? 'visible',
      });
    });
    showFrameUi();
  });

  // The stock RectangleTool, wired the way useAnnotationTool wires it.
  const tool = new RectangleTool();
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: () => undefined,
    canAddAnnotation: () => true,
    addAnnotation: (p) => {
      const g = getGeometryFromFabricObject(p.fabricObject, toolTypeToGeometryType(p.type));
      canvas.remove(p.fabricObject);
      if (g === null) return;
      tracks = [
        ...tracks,
        createTrack({
          id: createTrackId(`track-${tracks.length + 1}`),
          geometryType: g.type,
          keyframes: [{ frame: current, geometry: g, visibility: 'visible' }],
        }),
      ];
      applyTracks();
      canvas.requestRenderAll();
      showFrameUi();
    },
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };
  let mode: Mode = 'navigation';
  const toPoint = (opt: TPointerEventInfo): Point =>
    getScenePointFromEvent((pt: Point) => overlay.screenToImage(pt), opt);
  canvas.on('mouse:down', (opt) => {
    if (mode !== 'rectangle' || opt.target?.id !== undefined) return;
    tool.onPointerDown(opt.e as PointerEvent, toPoint(opt));
  });
  canvas.on('mouse:move', (opt) => {
    if (mode === 'rectangle') tool.onPointerMove(opt.e as PointerEvent, toPoint(opt));
  });
  canvas.on('mouse:up', (opt) => {
    if (mode === 'rectangle') tool.onPointerUp(opt.e as PointerEvent, toPoint(opt));
  });

  const setMode = (m: Mode): void => {
    if (mode === 'rectangle') tool.deactivate();
    mode = m;
    overlay.setMode(m === 'navigation' ? 'navigation' : 'annotation');
    if (m === 'rectangle') tool.activate(overlay, imageId, callbacks, DEFAULT_KEYBOARD_SHORTCUTS);
    for (const [id, el] of [
      ['rectangle', 'tool-rect'],
      ['select', 'tool-select'],
      ['navigation', 'tool-nav'],
    ] as const) {
      document.getElementById(el)!.setAttribute('aria-pressed', String(id === m));
    }
  };
  document.getElementById('tool-rect')!.addEventListener('click', () => setMode('rectangle'));
  document.getElementById('tool-select')!.addEventListener('click', () => setMode('select'));
  document.getElementById('tool-nav')!.addEventListener('click', () => setMode('navigation'));
  const slider = document.getElementById('scrub') as HTMLInputElement;
  slider.max = String(v.frameCount - 1);
  slider.addEventListener('input', () => void scrub(Number(slider.value)));

  /** A brush mask: a disc painted with the stock mask buffer, as the brush tool would. */
  const brushMask = (cx: number, cy: number, r: number): { g: Geometry; raw: Payload } => {
    const buf = new BoundedDenseMaskBuffer({ imageWidth: v.width, imageHeight: v.height });
    stampCircle(buf, cx, cy, r, 1);
    stampCircle(buf, cx + r * 0.8, cy, r * 0.6, 1);
    const f = maskAnnotationFields(buf.snapshot(), 'rgba(255, 200, 0, 0.55)');
    return { g: f.geometry, raw: f.rawAnnotationData };
  };

  const addDemoTracks = (): string[] => {
    const kf = (
      frame: number,
      geometry: Geometry,
      visibility: Visibility,
      payload?: Payload,
    ): Keyframe<Payload> =>
      payload === undefined
        ? { frame, geometry, visibility }
        : { frame, geometry, visibility, payload };
    const poly = createTrack<Payload>({
      id: createTrackId('polygon-12-to-24'),
      geometryType: 'polygon',
      keyframes: [
        kf(100, { type: 'polygon', points: starPolygon(12, 900, 260, 90, true) }, 'visible'),
        // Redrawn: twice the vertices, opposite winding, another start vertex.
        kf(
          130,
          {
            type: 'polygon',
            points: (() => {
              const p = starPolygon(24, 1000, 320, 110, false);
              return [...p.slice(7), ...p.slice(0, 7)];
            })(),
          },
          'visible',
        ),
        kf(140, { type: 'polygon', points: starPolygon(24, 1000, 320, 110, false) }, 'outside'),
        kf(160, { type: 'polygon', points: starPolygon(12, 1050, 340, 90, true) }, 'visible'),
      ],
    });
    const a = brushMask(300, 520, 45);
    const b = brushMask(470, 540, 65);
    const mask = createTrack<Payload>({
      id: createTrackId('mask-held'),
      geometryType: 'mask',
      keyframes: [kf(100, a.g, 'visible', a.raw), kf(130, b.g, 'visible', b.raw)],
    });
    tracks = [...tracks, poly, mask];
    applyTracks();
    canvas.requestRenderAll();
    showFrameUi();
    return [poly.id, mask.id];
  };

  /** Mark a track occluded / outside (or visible again) from the current frame on. */
  const setVisibility = (trackId: string, visibility: Visibility): void => {
    tracks = tracks.map((t) => {
      if (t.id !== trackId) return t;
      const s = sampleTrack(t, current, cache);
      const prev = t.keyframes.filter((k) => k.frame <= current).at(-1) ?? t.keyframes[0]!;
      const geometry = s?.geometry ?? prev.geometry;
      const payload = s?.payload ?? prev.payload;
      return upsertKeyframe(
        t,
        payload === undefined
          ? { frame: current, geometry, visibility }
          : { frame: current, geometry, visibility, payload },
      );
    });
    applyTracks();
    canvas.requestRenderAll();
    showFrameUi();
  };

  /**
   * Paint only `trackId`'s object (synchronously, through Fabric's own
   * render, cache included) and return the box of painted pixels next to the
   * box its rectangle geometry maps to. A stale object cache after an
   * in-place update would show up as a mismatch.
   */
  const renderedBox = (trackId: string): RenderedBox | null => {
    const t = tracks.find((x) => x.id === trackId);
    const shown = objects.get(trackId);
    const s = t === undefined ? null : sampleTrack(t, current, cache);
    if (shown === undefined || s === null || s.geometry.type !== 'rectangle') return null;
    const g = s.geometry;
    // Selection controls draw on the same canvas; measure the object alone.
    canvas.discardActiveObject();
    const others = canvas.getObjects().filter((o) => o !== shown.obj && o.visible);
    for (const o of others) o.visible = false;
    canvas.renderAll();
    const el = canvas.lowerCanvasEl;
    const ctx = el.getContext('2d')!;
    const img = ctx.getImageData(0, 0, el.width, el.height);
    for (const o of others) o.visible = true;
    canvas.renderAll();
    const k = el.width / canvas.getWidth();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3]! > 100) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const geometryBox = boxOf(
      [
        g.origin,
        { x: g.origin.x + g.width, y: g.origin.y },
        { x: g.origin.x, y: g.origin.y + g.height },
        { x: g.origin.x + g.width, y: g.origin.y + g.height },
      ].map((p) => overlay.imageToScreen(p)),
    );
    const objectBox = boxOf(shown.obj.getCoords().map((p) => overlay.imageToScreen(p)));
    const painted = x1 < 0 ? null : { x0: x0 / k, y0: y0 / k, x1: (x1 + 1) / k, y1: (y1 + 1) / k };
    return {
      painted,
      objectBox,
      geometryBox,
      maxEdgeErrPx: painted === null ? Infinity : maxEdgeDiff(painted, objectBox),
      geometryOffsetPx: maxEdgeDiff(objectBox, geometryBox),
      objectCaching: shown.obj.objectCaching,
      originX: String(shown.obj.originX),
    };
  };

  await scrub(0);

  window.__tracks = {
    ready: true,
    scrub,
    setMode,
    addDemoTracks,
    setVisibility,
    renderedBox,
    trackIds: () => tracks.map((t) => t.id),
    counters: () => ({ ...counters, correspondences: cache.misses }),
    zoomBy: (factor: number) => {
      viewer.viewport.zoomBy(factor, undefined, true);
      viewer.viewport.applyConstraints(true);
    },
    imageToScreen: (p: Point) => {
      const r = (document.getElementById('viewer') as HTMLElement).getBoundingClientRect();
      const s = overlay.imageToScreen(p);
      return { x: s.x + r.left, y: s.y + r.top };
    },
    document: () => JSON.parse(JSON.stringify(toTrackDocument(tracks))) as unknown,
    stats: () => ({ ...src.stats, cachePeakMB: src.cache.peakBytes / 1e6 }),
  };
}

declare global {
  interface Window {
    __tracks: {
      ready: boolean;
      scrub: (frame: number) => Promise<ScrubResult>;
      setMode: (m: Mode) => void;
      addDemoTracks: () => string[];
      setVisibility: (trackId: string, visibility: Visibility) => void;
      renderedBox: (trackId: string) => RenderedBox | null;
      trackIds: () => string[];
      counters: () => Record<string, number>;
      zoomBy: (factor: number) => void;
      imageToScreen: (p: Point) => Point;
      document: () => unknown;
      stats: () => Record<string, number>;
    };
    __tracksError?: string;
  }
}

main().catch((e: unknown) => {
  window.__tracksError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(e);
});
