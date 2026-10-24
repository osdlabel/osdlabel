/**
 * H2 harness: play a 1080p video under the existing FabricOverlay, through
 * one of these hosts, while the bench measures fps, CPU and sync:
 *
 *   host=osd-canvas  frame drawn into a one-tile canvas TileSource, OSD canvas drawer
 *   host=osd-webgl   frame uploaded into the OSD WebGL drawer's tile texture
 *   host=css         OSD keeps the viewport, gestures and overlay sync, but the
 *                    frame is a <video> (or <canvas>) element under the Fabric
 *                    canvas with a CSS matrix equal to Fabric's viewportTransform
 *
 *   source=video      HTMLVideoElement playback; which frame is on screen comes
 *                     from requestVideoFrameCallback's mediaTime
 *   source=webcodecs  WebCodecsFrameSource decodes frame i for clock time t
 *
 * The overlay carries 50 interpolated track rectangles, a green square
 * abutting the video's red marker (spatial sync), and a 4x4 code of the frame
 * index it believes is shown, beside the video's own code (temporal sync).
 * With `deco=1` (the default) every track also gets two DOM decorations from
 * the stock providers (its label and its area), recomputed each frame through
 * the existing DecorationLayer.
 */
import OpenSeadragon from 'openseadragon';
import { Rect } from 'fabric';
import { DecorationLayer, FabricOverlay } from '@osdlabel/fabric-osd';
import { createAnnotationId } from '@osdlabel/annotation';
import type { Annotation, Geometry } from '@osdlabel/annotation';
import { composeProviders, createLabelProvider, createMeasurementProvider } from 'osdlabel';
import {
  createFrameMaterializer,
  createTimestampAxis,
  createTrack,
  createTrackId,
  frameAt,
} from '@osdlabel/temporal';
import type { TrackBase } from '@osdlabel/temporal';
import { createCanvasTileSource, uploadToWebglTile } from './lib/canvas-tile-source.js';
import type { VideoInfo } from './lib/manifest.js';
import { loadManifest, mediaUrl } from './lib/manifest.js';
import type { WebCodecsFrameSource } from '@osdlabel/video';
import { openFrameSource } from './lib/open-frame-source.js';
import { mulberry32 } from './lib/rng.js';

type Host = 'osd-canvas' | 'osd-webgl' | 'css';
type Source = 'video' | 'webcodecs';

const params = new URLSearchParams(location.search);
const host = (params.get('host') ?? 'osd-canvas') as Host;
const source = (params.get('source') ?? 'video') as Source;
const videoName = params.get('video') ?? 'h264-1080p-30-g30-bf';
const TRACKS = Number(params.get('tracks') ?? '50');
const DECORATIONS = (params.get('deco') ?? '1') !== '0';

interface Stats {
  raf: number;
  contentFrames: number;
  lateFrames: number;
  skippedFrames: number;
  handlerMs: number;
  osdDrawMs: number;
  osdDraws: number;
  fabricMs: number;
  fabricRenders: number;
  decoMs: number;
  t0: number;
  droppedAtStart: number;
}

const stats: Stats = {
  raf: 0,
  contentFrames: 0,
  lateFrames: 0,
  skippedFrames: 0,
  handlerMs: 0,
  osdDrawMs: 0,
  osdDraws: 0,
  fabricMs: 0,
  fabricRenders: 0,
  decoMs: 0,
  t0: performance.now(),
  droppedAtStart: 0,
};

let video: HTMLVideoElement | null = null;
let motion = false;
let motionT0 = 0;
let lastShown = -1;
let pendingFrame = -1;

function buildTracks(v: VideoInfo): TrackBase[] {
  const rnd = mulberry32(5);
  const tracks: TrackBase[] = [];
  for (let k = 0; k < TRACKS; k++) {
    const keyframes = [];
    for (let f = 0; f < v.frameCount; f += 30) {
      const g: Geometry = {
        type: 'rectangle',
        origin: { x: rnd() * (v.width - 200), y: v.height * 0.45 + rnd() * (v.height * 0.45) },
        width: 40 + rnd() * 120,
        height: 40 + rnd() * 80,
        rotation: 0,
      };
      keyframes.push({ frame: f, geometry: g, visibility: 'visible' as const });
    }
    tracks.push(createTrack({ id: createTrackId(`t${k}`), geometryType: 'rectangle', keyframes }));
  }
  return tracks;
}

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const v = manifest[videoName];
  if (v === undefined) throw new Error(`unknown video ${videoName}`);
  const axis = createTimestampAxis(v.ptsUs, (1e6 * v.fpsDen) / v.fpsNum);

  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = host === 'css' ? 2 : v.width;
  tileCanvas.height = host === 'css' ? 2 : v.height;
  const tileCtx = tileCanvas.getContext('2d')!;

  const viewer = OpenSeadragon({
    element: document.getElementById('viewer')!,
    drawer: host === 'osd-webgl' ? 'webgl' : 'canvas',
    showNavigationControl: false,
    animationTime: 0.3,
    immediateRender: true,
    imageLoaderLimit: 1,
    preserveImageSizeOnResize: true,
    visibilityRatio: 0,
    constrainDuringPan: false,
    // OSD accepts a TileSource instance here; @types/openseadragon only lists option shapes.
    tileSources: createCanvasTileSource(
      tileCanvas,
      v.width,
      v.height,
    ) as unknown as OpenSeadragon.TileSourceOptions,
    ...(host === 'css' ? { opacity: 0 } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    viewer.addOnceHandler('open', () => resolve());
    viewer.addOnceHandler('open-failed', () => reject(new Error('open failed')));
  });

  // Time OSD's world draw (the tile path's GPU/CPU work lands here).
  const world = viewer.world as unknown as { draw: () => void };
  const origDraw = world.draw.bind(world);
  world.draw = (): void => {
    const t = performance.now();
    origDraw();
    stats.osdDrawMs += performance.now() - t;
    stats.osdDraws++;
  };

  const overlay = new FabricOverlay(viewer, { testMode: true });
  const canvas = overlay.canvas;
  const lay = v.layout;
  const m = lay.marker;

  // CSS host: the frame element lives under the Fabric canvas, transformed
  // by the same matrix Fabric uses.
  let cssEl: HTMLVideoElement | HTMLCanvasElement | null = null;
  let cssCtx: CanvasRenderingContext2D | null = null;
  const applyCss = (): void => {
    if (cssEl === null) return;
    const t = canvas.viewportTransform;
    cssEl.style.transform = `matrix(${t[0]},${t[1]},${t[2]},${t[3]},${t[4]},${t[5]})`;
  };

  video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = mediaUrl(v);

  if (host === 'css') {
    const el: HTMLVideoElement | HTMLCanvasElement =
      source === 'video' ? video : document.createElement('canvas');
    if (el instanceof HTMLCanvasElement) {
      el.width = v.width;
      el.height = v.height;
      cssCtx = el.getContext('2d');
    }
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${v.width}px`,
      height: `${v.height}px`,
      transformOrigin: '0 0',
      pointerEvents: 'none',
    });
    // Directly under the Fabric container (the overlay appended it last).
    const fabricContainer = overlay.overlayElement;
    fabricContainer.parentElement!.insertBefore(el, fabricContainer);
    cssEl = el;
    overlay.onSync(applyCss);
    applyCss();
  } else if (source === 'video') {
    // Kept in the DOM (and nominally visible) so Chrome does not suspend it.
    Object.assign(video.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '16px',
      height: '9px',
      opacity: '0.01',
    });
    document.body.appendChild(video);
  }

  // ── overlay content ─────────────────────────────────────────────
  const tracks = buildTracks(v);
  const rects = new Map<string, Rect>();
  for (const t of tracks) {
    const r = new Rect({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      fill: 'rgba(0,128,255,0.15)',
      stroke: '#0af',
      strokeWidth: 2,
      strokeUniform: true,
      originX: 'left',
      originY: 'top',
      objectCaching: false,
      selectable: false,
      evented: false,
    });
    rects.set(t.id, r);
    canvas.add(r);
  }
  const green = new Rect({
    left: m.x + m.size,
    top: m.y,
    width: m.size,
    height: m.size,
    fill: '#00ff00',
    originX: 'left',
    originY: 'top',
    strokeWidth: 0,
    objectCaching: false,
    selectable: false,
    evented: false,
  });
  canvas.add(green);
  const cell = m.size / 4;
  const code: Rect[] = [];
  for (let k = 0; k < 16; k++) {
    const r = new Rect({
      left: m.x + m.size + (k % 4) * cell,
      top: m.y + m.size + Math.floor(k / 4) * cell,
      width: cell,
      height: cell,
      fill: '#000',
      originX: 'left',
      originY: 'top',
      strokeWidth: 0,
      objectCaching: false,
      selectable: false,
      evented: false,
    });
    code.push(r);
    canvas.add(r);
  }
  const materialize = createFrameMaterializer(
    (t: TrackBase, s): Annotation => ({
      id: createAnnotationId(t.id),
      geometry: s.geometry,
      toolType: 'rectangle',
      label: t.id,
      createdAt: '',
      updatedAt: '',
    }),
  );
  const decorations = DECORATIONS ? new DecorationLayer(overlay) : null;
  const provider = composeProviders([
    createLabelProvider(),
    createMeasurementProvider({ area: true }),
  ]);

  const applyFrameToOverlay = (idx: number): void => {
    const t = performance.now();
    const anns = materialize(tracks, idx);
    for (const a of anns) {
      const r = rects.get(a.id)!;
      const g = a.geometry;
      if (g.type === 'rectangle') {
        r.set({ left: g.origin.x, top: g.origin.y, width: g.width, height: g.height });
        r.setCoords();
      }
    }
    for (let k = 0; k < 16; k++) {
      code[k]!.set({ fill: (idx >> (15 - k)) & 1 ? '#fff' : '#000' });
    }
    if (decorations !== null) {
      const td = performance.now();
      decorations.setDecorations(provider({ annotations: anns, selectedAnnotationId: null }));
      stats.decoMs += performance.now() - td;
    }
    overlay.sync();
    stats.fabricMs += performance.now() - t;
    stats.fabricRenders++;
  };

  // OSD hosts: apply the overlay for the new frame inside OSD's own draw pass
  // (update-viewport fires right after world.draw), so image and overlay
  // change in the same rAF.
  if (host !== 'css') {
    viewer.addHandler('update-viewport', () => {
      if (pendingFrame >= 0) {
        const idx = pendingFrame;
        pendingFrame = -1;
        applyFrameToOverlay(idx);
      }
    });
  }

  const showFrame = (idx: number, draw: () => void): void => {
    const t = performance.now();
    if (lastShown >= 0 && idx !== lastShown) {
      const expected = (lastShown + 1) % v.frameCount;
      if (idx !== expected) stats.skippedFrames += (idx - expected + v.frameCount) % v.frameCount;
    }
    lastShown = idx;
    stats.contentFrames++;
    draw();
    if (host === 'css') {
      applyFrameToOverlay(idx);
    } else {
      pendingFrame = idx;
      viewer.forceRedraw();
    }
    stats.handlerMs += performance.now() - t;
  };

  const drawSource = (src: CanvasImageSource & TexImageSource): void => {
    if (host === 'osd-canvas') tileCtx.drawImage(src, 0, 0, v.width, v.height);
    else if (host === 'osd-webgl') {
      if (!uploadToWebglTile(viewer.drawer, tileCanvas, src)) {
        tileCtx.drawImage(src, 0, 0, v.width, v.height);
      }
    } else if (cssCtx !== null) cssCtx.drawImage(src, 0, 0, v.width, v.height);
  };

  // ── frame sources ────────────────────────────────────────────────
  let wc: WebCodecsFrameSource | null = null;
  if (source === 'video') {
    await new Promise<void>((resolve) =>
      video!.addEventListener('loadeddata', () => resolve(), { once: true }),
    );
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
      const idx = frameAt(axis, meta.mediaTime * 1e6 + 500);
      showFrame(idx, () => drawSource(video!));
      video!.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    wc = (
      await openFrameSource(mediaUrl(v), {
        cacheFrames: 6,
        cacheBytes: 256 * 1024 ** 2,
      })
    ).source;
  }

  // WebCodecs playback: a decode-ahead queue and a wall clock.
  const ready = new Map<number, VideoFrame>();
  let next = 0;
  let inflight = false;
  let playT0 = -1;
  const AHEAD = 4;
  const pump = (): void => {
    if (wc === null || inflight || ready.size >= AHEAD) return;
    inflight = true;
    const i = next;
    next = (next + 1) % v.frameCount;
    void wc.getFrame(i).then((f) => {
      ready.set(i, f);
      inflight = false;
      pump();
    });
  };

  const tick = (now: number): void => {
    stats.raf++;
    if (motion) {
      const s = (now - motionT0) / 1000;
      const z = 1.4 + 0.4 * Math.sin(s * 1.3);
      const vp = viewer.viewport;
      vp.zoomTo(z, undefined, true);
      vp.panTo(
        new OpenSeadragon.Point(0.5 + 0.08 * Math.sin(s * 0.9), 0.16 + 0.03 * Math.cos(s * 0.7)),
        true,
      );
    }
    if (wc !== null && playT0 >= 0) {
      const tUs =
        ((now - playT0) * 1000) % (v.ptsUs[v.frameCount - 1]! + (1e6 * v.fpsDen) / v.fpsNum);
      const want = frameAt(axis, tUs);
      if (want !== lastShown) {
        // What a player does: show the newest decoded frame that is not in
        // the future (the wanted one when decode keeps up), never a stale one.
        const N = v.frameCount;
        const lag = (k: number): number => (want - k + N) % N;
        let best = -1;
        for (const k of ready.keys()) {
          if (lag(k) < N / 2 && (best < 0 || lag(k) < lag(best))) best = k;
        }
        if (best >= 0 && best !== want) stats.lateFrames++;
        // Decoding (or the main thread) cannot keep up: skip ahead rather
        // than drift ever further behind the clock.
        if (best >= 0 && lag(best) > AHEAD * 2 && !inflight) next = (want + 2) % N;
        if (best >= 0 && (lastShown < 0 || lag(best) < lag(lastShown))) {
          const f = ready.get(best)!;
          showFrame(best, () => drawSource(f));
        } else if (best < 0) {
          stats.lateFrames++;
          // Nothing usable decoded: when nothing near is coming either,
          // restart decoding a little ahead of the clock instead of at it,
          // so the frame is still current when it arrives.
          const ahead = [...ready.keys()].some((k) => (k - want + N) % N <= AHEAD * 2);
          if (!ahead && !inflight) next = (want + 2) % N;
        }
        // Drop everything at or behind the clock; frames ahead stay queued.
        for (const [k, fr] of ready) {
          if (lag(k) < N / 2) {
            fr.close();
            ready.delete(k);
          }
        }
      }
      pump();
    }
    const hud = document.getElementById('hud');
    if (hud !== null && stats.raf % 30 === 0)
      hud.textContent = `${host}/${source} frame ${lastShown}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__render = {
    ready: true,
    info: {
      host,
      source,
      video: v.name,
      width: v.width,
      height: v.height,
      layout: v.layout,
      decorations: DECORATIONS,
      tracks: TRACKS,
    },
    async play(): Promise<void> {
      if (source === 'video') await video!.play();
      else {
        playT0 = performance.now();
        pump();
      }
    },
    setMotion(on: boolean): void {
      motion = on;
      motionT0 = performance.now();
    },
    resetStats(): void {
      Object.assign(stats, {
        raf: 0,
        contentFrames: 0,
        lateFrames: 0,
        skippedFrames: 0,
        handlerMs: 0,
        osdDrawMs: 0,
        osdDraws: 0,
        fabricMs: 0,
        fabricRenders: 0,
        decoMs: 0,
        t0: performance.now(),
        droppedAtStart: video?.getVideoPlaybackQuality().droppedVideoFrames ?? 0,
      });
    },
    stats(): Record<string, number> {
      const wall = (performance.now() - stats.t0) / 1000;
      const q = source === 'video' ? video!.getVideoPlaybackQuality() : null;
      return {
        wallS: wall,
        rafFps: stats.raf / wall,
        contentFps: stats.contentFrames / wall,
        skippedFrames: stats.skippedFrames,
        lateFrames: stats.lateFrames,
        droppedVideoFrames: q === null ? 0 : q.droppedVideoFrames - stats.droppedAtStart,
        handlerMsPerFrame: stats.handlerMs / Math.max(1, stats.contentFrames),
        osdDrawMsPerDraw: stats.osdDrawMs / Math.max(1, stats.osdDraws),
        osdDrawsPerS: stats.osdDraws / wall,
        // fabricMs is the whole per-frame overlay update; report the Fabric part
        // and the decoration part (providers + DecorationLayer diff) apart.
        fabricMsPerRender: (stats.fabricMs - stats.decoMs) / Math.max(1, stats.fabricRenders),
        decoMsPerFrame: stats.decoMs / Math.max(1, stats.fabricRenders),
        decorationElements: document.querySelectorAll('[data-osdlabel="decoration-layer"] > *')
          .length,
        fabricRendersPerS: stats.fabricRenders / wall,
        mainThreadJsMsPerS: (stats.handlerMs + stats.osdDrawMs + stats.fabricMs) / wall,
        lastShown,
      };
    },
    /** Where the marker is on screen right now (image -> screen via the overlay transform). */
    markerScreen(): { x: number; y: number; scale: number } {
      const t = canvas.viewportTransform;
      return {
        x: t[0] * m.x + t[2] * m.y + t[4],
        y: t[1] * m.x + t[3] * m.y + t[5],
        scale: Math.hypot(t[0], t[1]),
      };
    },
  };
}

declare global {
  interface Window {
    __render: {
      ready: boolean;
      info: Record<string, unknown>;
      play: () => Promise<void>;
      setMotion: (on: boolean) => void;
      resetStats: () => void;
      stats: () => Record<string, number>;
      markerScreen: () => { x: number; y: number; scale: number };
    };
    __renderError?: string;
  }
}

main().catch((e: unknown) => {
  window.__renderError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(e);
});
