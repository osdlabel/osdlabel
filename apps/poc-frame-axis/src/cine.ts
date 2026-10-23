/**
 * H3: cine playback through the winning H2 path (one TiledImage, one tile
 * repainted in place — FramePresenter) with per-frame annotations (a chamber
 * outline, a caliper, a point) and live measurement decorations.
 *
 * Four pixel paths for the same 100-frame 800x600 RGB loop:
 *  - `rgba`      raw ImageData per frame, putImageData on show (1.9 MB upload/frame)
 *  - `bitmap`    pre-decoded ImageBitmap per frame, drawImage on show
 *  - `webcodecs` frames encoded once to H.264 in the page (VideoEncoder), then
 *                decoded on the fly while playing (VideoDecoder -> VideoFrame);
 *                only a few frames are ever resident
 *  - `video`     the loop recorded to WebM (MediaRecorder), played by a <video>
 *                element; each presented frame is drawn into the tile from
 *                requestVideoFrameCallback, and its annotations are chosen from
 *                `mediaTime` — the way a real cine file would be annotated
 *
 * A frame counts as dropped when its presentation slot (1/fps) passed without
 * OSD drawing it. For `video` the ground truth is the barcode decoded from the
 * presented frame's own pixels, since the element's clock decides which frame
 * is presented.
 */
import OpenSeadragon from 'openseadragon';
import { DecorationLayer, FabricOverlay } from '@osdlabel/fabric-osd';
import { DEFAULT_VIEWER_OPTIONS } from '@osdlabel/osd-helper';
import type { FrameSource } from '@osdlabel/frame-osd';
import { FramePresenter } from '@osdlabel/frame-osd';
import { createLabelProvider, createMeasurementProvider } from '@osdlabel/decoration';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { frameIndexAtTime } from '@osdlabel/frame';
import type { FrameAxis } from '@osdlabel/frame';
import type { OsdAnnotation, OsdFields } from 'osdlabel';
import type { VectorGeometry } from '@osdlabel/annotation';
import { chamberAt, renderUltrasoundFrame } from './data/ultrasound.js';
import {
  decodeFrameMarker,
  markerBlockCenter,
  MARKER_BITS,
  MARKER_BLOCK,
  MARKER_ORIGIN,
} from './data/marker.js';
import { BitmapFrameStore, RgbaFrameStore } from './data/frame-stores.js';
import { buildAnnotation, createAnnotationLayer, fabricTuning } from './annotations/layers.js';
import {
  canvasTag,
  FrameRateProbe,
  Recorder,
  sleep,
  tagCanvas,
  waitFrames,
} from './instrument/recorder.js';
import { analyzeDisplayLog } from './instrument/display-log.js';
import { roundDeep, summarize } from './instrument/stats.js';

export interface CineOptions {
  readonly source: 'rgba' | 'bitmap' | 'webcodecs' | 'video';
  readonly drawer: 'canvas' | 'webgl';
  readonly fps: number;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly annotationsPerFrame: number;
  readonly decorations: boolean;
  readonly loops: number;
}

const imageId = createImageId('cine-1');
const contextId = createAnnotationContextId('ctx');

function cineAnnotations(i: number, w: number, h: number, n: number): OsdAnnotation[] {
  const c = chamberAt(i, w, h);
  const outline: VectorGeometry = {
    type: 'polygon',
    points: Array.from({ length: 16 }, (_, k) => {
      const a = (2 * Math.PI * k) / 16;
      return { x: c.cx + Math.cos(a) * c.rx, y: c.cy + Math.sin(a) * c.ry };
    }),
  };
  const caliper: VectorGeometry = {
    type: 'line',
    start: { x: c.cx - c.rx, y: c.cy },
    end: { x: c.cx + c.rx, y: c.cy },
  };
  const point: VectorGeometry = { type: 'point', position: { x: c.cx, y: c.cy - c.ry } };
  const specs = [outline, caliper, point].slice(0, n);
  return specs.map((geometry, ordinal) =>
    buildAnnotation(
      { frame: i, ordinal, geometry, label: ordinal === 0 ? 'LV' : undefined },
      imageId,
      contextId,
      undefined,
    ),
  );
}

/** Reads the frame barcode from a canvas region (cheap: a 104x8 CPU canvas). */
class MarkerReader {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w = MARKER_ORIGIN + (MARKER_BITS + 1) * MARKER_BLOCK;
  constructor() {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = MARKER_ORIGIN + MARKER_BLOCK;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d unavailable');
    this.ctx = ctx;
  }
  read(src: CanvasImageSource): number {
    this.ctx.drawImage(
      src,
      0,
      0,
      this.w,
      this.ctx.canvas.height,
      0,
      0,
      this.w,
      this.ctx.canvas.height,
    );
    const data = this.ctx.getImageData(0, 0, this.w, this.ctx.canvas.height).data;
    const samples: number[] = [];
    for (let b = 0; b <= MARKER_BITS; b++) {
      const p = markerBlockCenter(b);
      const o = (Math.floor(p.y) * this.w + Math.floor(p.x)) * 4;
      samples.push(((data[o] ?? 0) + (data[o + 1] ?? 0) + (data[o + 2] ?? 0)) / 3);
    }
    return decodeFrameMarker(samples);
  }
}

/** WebCodecs: H.264 chunks encoded once; decoded ahead of the playhead while playing. */
class DecodingFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  private readonly chunks: { type: EncodedVideoChunkType; data: ArrayBuffer }[];
  private readonly config: VideoDecoderConfig;
  private decoder: VideoDecoder | undefined;
  private readonly ready = new Map<number, VideoFrame>();
  private fed = 0;
  private readonly ahead: number;
  paintMs = 0;
  paints = 0;
  misses = 0;
  decoded = 0;

  constructor(
    width: number,
    height: number,
    chunks: { type: EncodedVideoChunkType; data: ArrayBuffer }[],
    config: VideoDecoderConfig,
    ahead = 8,
  ) {
    this.width = width;
    this.height = height;
    this.count = chunks.length;
    this.chunks = chunks;
    this.config = config;
    this.ahead = ahead;
  }

  start(): void {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.decoded++;
        this.ready.set(Math.round(frame.timestamp / 1000), frame);
      },
      error: (e) => console.error('decode error', e),
    });
    this.decoder.configure(this.config);
    this.feed(0);
  }

  /** Keep `ahead` frames queued after global frame `g` (frames are numbered across loops). */
  feed(g: number): void {
    const d = this.decoder;
    if (!d) return;
    while (this.fed < g + this.ahead) {
      const i = this.fed % this.count;
      const c = this.chunks[i]!;
      // A loop restarts on frame 0, which is a key frame.
      d.decode(new EncodedVideoChunk({ type: c.type, timestamp: this.fed * 1000, data: c.data }));
      this.fed++;
    }
  }

  /** Paint global frame `g` (the caller tracks loops). */
  paintGlobal(g: number, ctx: CanvasRenderingContext2D): boolean {
    this.feed(g);
    const f = this.ready.get(g);
    // Frames behind the playhead are never shown: close them.
    for (const [k, v] of this.ready) {
      if (k < g) {
        v.close();
        this.ready.delete(k);
      }
    }
    if (!f) {
      this.misses++;
      return false;
    }
    const t0 = performance.now();
    ctx.drawImage(f, 0, 0);
    tagCanvas(ctx.canvas, g % this.count);
    f.close();
    this.ready.delete(g);
    this.paintMs += performance.now() - t0;
    this.paints++;
    return true;
  }

  paint(): boolean {
    return false;
  }

  stop(): void {
    for (const f of this.ready.values()) f.close();
    this.ready.clear();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }
}

async function encodeH264(
  frames: readonly ImageData[],
  fps: number,
): Promise<{
  chunks: { type: EncodedVideoChunkType; data: ArrayBuffer }[];
  config: VideoDecoderConfig;
  bytes: number;
}> {
  const chunks: { type: EncodedVideoChunkType; data: ArrayBuffer }[] = [];
  let decoderConfig: VideoDecoderConfig | undefined;
  const first = frames[0]!;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ type: chunk.type, data });
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e) => console.error('encode error', e),
  });
  encoder.configure({
    codec: 'avc1.42001f',
    width: first.width,
    height: first.height,
    bitrate: 4_000_000,
    framerate: fps,
    avc: { format: 'annexb' },
    latencyMode: 'quality',
  });
  for (let i = 0; i < frames.length; i++) {
    const bmp = await createImageBitmap(frames[i]!);
    const vf = new VideoFrame(bmp, { timestamp: i * 1000 });
    encoder.encode(vf, { keyFrame: i % 30 === 0 });
    vf.close();
    bmp.close();
  }
  await encoder.flush();
  encoder.close();
  if (!decoderConfig) throw new Error('no decoder config from encoder');
  return {
    chunks,
    config: decoderConfig,
    bytes: chunks.reduce((s, c) => s + c.data.byteLength, 0),
  };
}

/** Record the loop to WebM through MediaRecorder (real time: frames/fps seconds). */
async function recordWebm(
  frames: readonly ImageData[],
  fps: number,
): Promise<{ url: string; bytes: number }> {
  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d unavailable');
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  for (let i = 0; i < frames.length; i++) {
    ctx.putImageData(frames[i]!, 0, 0);
    track.requestFrame();
    await sleep(1000 / fps);
  }
  rec.stop();
  await done;
  const blob = new Blob(parts, { type: 'video/webm' });
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

/** A frame source that paints whatever the <video> element currently presents. */
class VideoElementSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  paintMs = 0;
  paints = 0;
  constructor(
    private readonly video: HTMLVideoElement,
    count: number,
  ) {
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.count = count;
  }
  paint(index: number, ctx: CanvasRenderingContext2D): boolean {
    const t0 = performance.now();
    ctx.drawImage(this.video, 0, 0, this.width, this.height);
    tagCanvas(ctx.canvas, index);
    this.paintMs += performance.now() - t0;
    this.paints++;
    return true;
  }
}

export async function runCine(
  cell: HTMLElement,
  opts: CineOptions,
): Promise<Record<string, unknown>> {
  cell.innerHTML = '';
  fabricTuning.objectCaching = true;
  const tPrep = performance.now();
  const frames: ImageData[] = [];
  for (let i = 0; i < opts.frames; i++) {
    const img = new ImageData(opts.width, opts.height);
    renderUltrasoundFrame(i, opts.width, opts.height, img.data);
    frames.push(img);
  }
  const genMs = performance.now() - tPrep;

  let source: FrameSource & { paintMs: number; paints: number };
  let decoding: DecodingFrameSource | undefined;
  let video: HTMLVideoElement | undefined;
  let encodedBytes = 0;
  const tSrc = performance.now();
  switch (opts.source) {
    case 'rgba':
      source = new RgbaFrameStore(opts.width, opts.height, frames);
      break;
    case 'bitmap':
      source = new BitmapFrameStore(
        opts.width,
        opts.height,
        await Promise.all(frames.map((f) => createImageBitmap(f))),
      );
      break;
    case 'webcodecs': {
      const enc = await encodeH264(frames, opts.fps);
      encodedBytes = enc.bytes;
      decoding = new DecodingFrameSource(opts.width, opts.height, enc.chunks, enc.config);
      source = decoding;
      break;
    }
    case 'video': {
      const rec = await recordWebm(frames, opts.fps);
      encodedBytes = rec.bytes;
      video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = rec.url;
      await new Promise<void>((resolve, reject) => {
        video!.onloadeddata = () => resolve();
        video!.onerror = () => reject(new Error('video load failed'));
      });
      source = new VideoElementSource(video, opts.frames);
      break;
    }
  }
  const sourceMs = performance.now() - tSrc;
  // Drop the generator's frames when the source does not need them, so the
  // memory delta reflects the playback path, not the synthesis.
  if (opts.source === 'webcodecs' || opts.source === 'video' || opts.source === 'bitmap') {
    frames.length = 0;
  }

  const viewer = OpenSeadragon({
    ...DEFAULT_VIEWER_OPTIONS,
    element: cell,
    drawer: opts.drawer,
    immediateRender: true,
    imageLoaderLimit: 0,
    preserveViewport: true,
  } as OpenSeadragon.Options);
  const presenter = new FramePresenter(viewer, source);
  await new Promise<void>((resolve) => {
    viewer.addOnceHandler('open', () => resolve());
    presenter.open();
  });
  const overlay = new FabricOverlay(viewer);
  const decorationLayer = opts.decorations ? new DecorationLayer(overlay) : undefined;
  viewer.viewport.fitBounds(new OpenSeadragon.Rect(0, 0, 1, opts.height / opts.width), true);
  overlay.sync();

  const byFrame = Array.from({ length: opts.frames }, (_, i) =>
    cineAnnotations(i, opts.width, opts.height, opts.annotationsPerFrame),
  );
  const layer = createAnnotationLayer('cache', overlay, byFrame);
  await layer.init();
  const providers = [
    createMeasurementProvider<OsdFields>({ area: true, length: true, perimeter: false }),
    createLabelProvider<OsdFields>(),
  ];
  const axis: FrameAxis = { kind: 'temporal', count: opts.frames, frameRate: opts.fps };

  const recorder = new Recorder();
  const renderMs: number[] = [];
  const drawMs: number[] = [];
  const applyMs: number[] = [];
  viewer.addHandler('update-viewport', () => {
    const item = viewer.world.getItemAt(0) as unknown as {
      getTilesToDraw(): { tile: { getCanvasContext?: () => CanvasRenderingContext2D | null } }[];
    };
    const t = item.getTilesToDraw()[0];
    recorder.log('img', canvasTag(t?.tile.getCanvasContext?.()?.canvas) ?? -1);
  });
  overlay.canvas.on('after:render', () => recorder.log('ann', layer.current));
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

  const showAnnotations = (i: number): void => {
    layer.show(i);
    if (decorationLayer) {
      const ctx = {
        annotations: byFrame[i] ?? [],
        pixelSpacing: { x: 0.2, y: 0.2, unit: 'mm' },
        selectedAnnotationId: null,
      };
      decorationLayer.setDecorations(providers.flatMap((p) => p(ctx)));
    }
  };

  const total = opts.frames * opts.loops;
  const period = 1000 / opts.fps;
  const probe = new FrameRateProbe();
  /** For each scheduled global frame: was it drawn during its slot? */
  const shownGlobal = new Set<number>();
  let truthMismatch = 0;
  let videoFrames = 0;
  const markerGaps: number[] = [];

  decoding?.start();
  if (decoding) await sleep(100); // let the decoder fill its look-ahead once
  recorder.recording = true;
  probe.start();
  const start = performance.now();

  if (opts.source !== 'video') {
    await new Promise<void>((resolve) => {
      let last = -1;
      const tick = (ts: number): void => {
        const g = Math.floor((performance.now() - start) / period);
        if (g >= total) {
          resolve();
          return;
        }
        if (g !== last) {
          const i = g % opts.frames;
          const t0 = performance.now();
          recorder.log('apply', i);
          const ok = decoding
            ? (() => {
                const ctx = presenter.canvas.getContext('2d');
                const painted = ctx ? decoding.paintGlobal(g, ctx) : false;
                if (painted) presenter.invalidate();
                return painted;
              })()
            : presenter.show(i);
          if (ok) {
            showAnnotations(i);
            last = g;
            shownGlobal.add(g);
          }
          applyMs.push(performance.now() - t0);
        }
        void ts;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } else {
    const v = video!;
    const reader = new MarkerReader();
    let lastMarker = -1;
    await v.play();
    await new Promise<void>((resolve) => {
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
        if (performance.now() - start >= total * period) {
          resolve();
          return;
        }
        videoFrames++;
        const t0 = performance.now();
        const fromTime = frameIndexAtTime(axis, meta.mediaTime + 0.25 / opts.fps);
        const truth = reader.read(v);
        if (truth !== fromTime) truthMismatch++;
        if (lastMarker >= 0 && truth >= 0) {
          const gap = (truth - lastMarker + opts.frames) % opts.frames;
          if (gap !== 1) markerGaps.push(gap);
        }
        lastMarker = truth;
        recorder.log('apply', truth);
        const ctx = presenter.canvas.getContext('2d');
        if (ctx) source.paint(truth, ctx);
        presenter.invalidate();
        showAnnotations(fromTime);
        applyMs.push(performance.now() - t0);
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    });
    v.pause();
  }

  const elapsed = performance.now() - start;
  await waitFrames(3);
  recorder.recording = false;
  const intervals = probe.stop();
  const a = analyzeDisplayLog(recorder.events);

  let dropped: number;
  let scheduled: number;
  if (opts.source === 'video') {
    // Frames the element never presented (gaps in the barcode sequence it
    // handed us) plus frames it presented that OSD never drew.
    const skipped = markerGaps.reduce((s, g) => s + Math.max(0, g - 1), 0);
    scheduled = videoFrames + skipped;
    dropped = skipped + Math.max(0, videoFrames - (a.slicesShown + 1));
  } else {
    scheduled = total;
    // A scheduled frame counts only if its own draw made it to the screen.
    dropped = total - Math.min(total, a.slicesShown + 1);
  }
  const quality = video?.getVideoPlaybackQuality();
  const result = roundDeep({
    genMs,
    sourceMs,
    prepMs: genMs + sourceMs,
    encodedBytes,
    elapsedMs: elapsed,
    scheduled,
    shown: a.slicesShown + 1,
    applied: shownGlobal.size,
    dropped,
    droppedPct: (100 * dropped) / Math.max(1, scheduled),
    achievedFps: ((a.slicesShown + 1) / elapsed) * 1000,
    displayFps: (intervals.length / elapsed) * 1000,
    frameIntervalMs: summarize(intervals),
    longFrames: intervals.filter((x) => x > period * 1.5).length,
    incoherentFrames: a.incoherentFrames,
    blankFrames: a.blankFrames,
    applyMs: summarize(applyMs),
    fabricRenderMs: summarize(renderMs),
    osdDrawMs: summarize(drawMs),
    paintMsPerFrame: source.paints > 0 ? source.paintMs / source.paints : 0,
    decoderMisses: decoding?.misses ?? null,
    videoFramesPresented: video ? videoFrames : null,
    videoDroppedByElement: quality ? quality.droppedVideoFrames : null,
    timeVsPixelMismatches: video ? truthMismatch : null,
    markerGaps: video ? markerGaps.length : null,
  });
  decoding?.stop();
  layer.dispose();
  decorationLayer?.destroy();
  overlay.destroy();
  viewer.destroy();
  if (source instanceof BitmapFrameStore) source.close();
  cell.innerHTML = '';
  return result;
}
