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
 */
import OpenSeadragon from 'openseadragon';
import type { FabricObject, TPointerEventInfo } from 'fabric';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import {
  RectangleTool,
  buildFabricObjectFromGeometry,
  getFabricOptions,
  getGeometryFromFabricObject,
} from '@osdlabel/fabric-annotations';
import type { ToolCallbacks } from '@osdlabel/fabric-annotations';
import { DEFAULT_KEYBOARD_SHORTCUTS, getScenePointFromEvent } from 'osdlabel';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { DEFAULT_ANNOTATION_STYLE, toolTypeToGeometryType } from '@osdlabel/annotation';
import type { Geometry, Point } from '@osdlabel/annotation';
import {
  createTrack,
  createTrackId,
  sampleTrack,
  toTrackDocument,
  upsertKeyframe,
} from '@osdlabel/temporal';
import type { TrackBase, TrackSample } from '@osdlabel/temporal';
import { createCanvasTileSource } from './lib/canvas-tile-source.js';
import { FrameProbe, loadManifest, mediaUrl } from './lib/manifest.js';
import { WebCodecsFrameSource } from './lib/webcodecs-frame-source.js';

type Mode = 'rectangle' | 'select' | 'navigation';

interface ScrubResult {
  readonly frame: number;
  readonly shown: number;
  readonly ms: number;
  readonly objects: readonly { id: string; geometry: Geometry | null; visible: boolean }[];
  readonly samples: readonly { id: string; source: TrackSample['source'] | null }[];
}

const params = new URLSearchParams(location.search);
const videoName = params.get('video') ?? 'h264-720p-30-g30-bf';

async function main(): Promise<void> {
  const v = (await loadManifest())[videoName];
  if (v === undefined) throw new Error(`unknown video ${videoName}`);
  const src = await WebCodecsFrameSource.open(mediaUrl(v), {
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
  let tracks: TrackBase[] = [];
  const objects = new Map<string, FabricObject>();
  let current = 0;

  /** Materialise every track on `current` into its Fabric object. */
  const applyTracks = (): TrackSample[] => {
    const out: TrackSample[] = [];
    for (const t of tracks) {
      const s = sampleTrack(t, current);
      let obj = objects.get(t.id);
      if (s !== null && s.geometry.type !== 'mask') {
        if (obj === undefined) {
          obj = buildFabricObjectFromGeometry(
            s.geometry,
            getFabricOptions(DEFAULT_ANNOTATION_STYLE, t.id),
          );
          objects.set(t.id, obj);
          canvas.add(obj);
          overlay.applyModeToObject(obj, false);
        } else {
          const fresh = buildFabricObjectFromGeometry(
            s.geometry,
            getFabricOptions(DEFAULT_ANNOTATION_STYLE, t.id),
          );
          obj.set({
            left: fresh.left,
            top: fresh.top,
            width: fresh.width,
            height: fresh.height,
            angle: fresh.angle,
            scaleX: 1,
            scaleY: 1,
          });
        }
        obj.set({ visible: true, strokeDashArray: s.keyframe !== null ? null : [6, 4] });
        obj.setCoords();
        out.push(s);
      } else if (obj !== undefined) {
        obj.set({ visible: false });
      }
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
        const o = objects.get(t.id);
        return {
          id: t.id,
          geometry: o === undefined ? null : getGeometryFromFabricObject(o, t.geometryType),
          visible: o?.visible ?? false,
        };
      }),
      samples: tracks.map((t) => ({ id: t.id, source: sampleTrack(t, frame)?.source ?? null })),
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
      return g === null
        ? t
        : upsertKeyframe(t, { frame: current, geometry: g, visibility: 'visible' });
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

  await scrub(0);

  window.__tracks = {
    ready: true,
    scrub,
    setMode,
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
