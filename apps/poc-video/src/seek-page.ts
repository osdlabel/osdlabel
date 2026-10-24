/**
 * H1 harness: is seeking frame-accurate?
 *
 * Two ways to put frame `i` on screen:
 *   - HTMLVideoElement: set `currentTime` (several policies for which time to
 *     ask for), wait for `seeked`, then up to {@link RVFC_WINDOW_MS} for the
 *     `requestVideoFrameCallback` of the presented frame.
 *   - WebCodecs: `@osdlabel/video`'s `WebCodecsFrameSource.getFrame(i)` over
 *     the mediabunny demuxer adapter (decode from the preceding key packet),
 *     or mediabunny's own `VideoSampleSink.getSample(t)` (`sinkRun`).
 * Either way the burned-in barcode says which frame actually arrived.
 *
 * `playPauseRun` collects the times an app would store if it saved
 * `video.currentTime` when the user paused playback, with the frame that was
 * on screen, for the frame-axis writer study.
 */
import { createTimestampAxis, frameAt } from '@osdlabel/temporal';
import type { WebCodecsFrameSource } from '@osdlabel/video';
import { MediabunnyDemuxer, MediabunnySampleFrameSource } from '@osdlabel/video/mediabunny';
import type { Manifest, VideoInfo } from './lib/manifest.js';
import { FrameProbe, loadManifest, mediaUrl } from './lib/manifest.js';
import { openFrameSource } from './lib/open-frame-source.js';
import { mulberry32 } from './lib/rng.js';

/**
 * How long after `seeked` to wait for the presented-frame callback. The
 * window opens at `seeked`, not when the seek is issued: the first harness
 * armed it before setting `currentTime`, so any seek slower than ~250 ms was
 * counted as "no callback" and its barcode was read at `seeked` (review B2).
 */
const RVFC_WINDOW_MS = 250;

export type SeekPolicy = 'boundary' | 'mid' | 'table-start' | 'table-mid' | 'increment';

export interface VideoOp {
  readonly target: number;
  readonly policy: SeekPolicy;
  /** For `increment`: +1 or -1 frame from the current position. */
  readonly dir?: number;
}

export interface VideoOpResult {
  readonly target: number;
  readonly policy: SeekPolicy;
  readonly requestedTime: number;
  /** Barcode read right after `seeked`. */
  readonly gotSeeked: number;
  /** Barcode read after the presented-frame callback (or {@link RVFC_WINDOW_MS} after `seeked`). */
  readonly got: number;
  /** `video.currentTime` read at `seeked`: the time an app storing currentTime would write. */
  readonly currentTime: number;
  readonly msSeeked: number;
  readonly msFrame: number;
  readonly rvfcFired: boolean;
  /** When the callback ran, relative to `seeked` (negative: before it); null if it did not. */
  readonly msRvfcAfterSeeked: number | null;
  /** Frame whose pts matches rVFC metadata.mediaTime (nearest), -1 if no callback. */
  readonly mediaTimeFrame: number;
  /** rVFC metadata.mediaTime, seconds (-1 if no callback). */
  readonly mediaTime: number;
  readonly mediaTimeErrUs: number;
}

export interface WebCodecsOpResult {
  readonly target: number;
  readonly got: number;
  readonly ms: number;
  readonly reset: boolean;
  readonly hit: boolean;
}

const probe = new FrameProbe(document.getElementById('probe') as HTMLCanvasElement);
const video = document.getElementById('video') as HTMLVideoElement;
let manifest: Manifest | null = null;

async function getManifest(): Promise<Manifest> {
  manifest ??= await loadManifest();
  return manifest;
}

function once(target: EventTarget, type: string, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      target.removeEventListener(type, on);
      resolve(false);
    }, timeoutMs);
    const on = (): void => {
      clearTimeout(t);
      resolve(true);
    };
    target.addEventListener(type, on, { once: true });
  });
}

async function openVideo(v: VideoInfo): Promise<void> {
  video.pause();
  video.src = mediaUrl(v);
  video.load();
  if (!(await once(video, 'loadeddata', 20000))) throw new Error(`${v.name}: video did not load`);
}

function nearestFrame(v: VideoInfo, timeUs: number): { frame: number; errUs: number } {
  const axis = createTimestampAxis(v.ptsUs, (1e6 * v.fpsDen) / v.fpsNum);
  let f = frameAt(axis, timeUs);
  const next = v.ptsUs[f + 1];
  if (next !== undefined && Math.abs(next - timeUs) < Math.abs(v.ptsUs[f]! - timeUs)) f++;
  return { frame: f, errUs: timeUs - v.ptsUs[f]! };
}

function timeFor(v: VideoInfo, op: VideoOp): number {
  const dt = v.fpsDen / v.fpsNum;
  switch (op.policy) {
    case 'boundary':
      return op.target * dt;
    case 'mid':
      return (op.target + 0.5) * dt;
    case 'table-start':
      return v.ptsUs[op.target]! / 1e6;
    case 'table-mid': {
      const a = v.ptsUs[op.target]!;
      const b = v.ptsUs[op.target + 1] ?? a + dt * 1e6;
      return (a + b) / 2e6;
    }
    case 'increment':
      return video.currentTime + (op.dir ?? 1) * dt;
  }
}

async function seekOp(v: VideoInfo, op: VideoOp): Promise<VideoOpResult> {
  const t = timeFor(v, op);
  let meta: VideoFrameCallbackMetadata | null = null;
  let rvfcAt = -1;
  let done: () => void = () => {};
  const rvfc = new Promise<void>((resolve) => (done = resolve));
  // Requested before the seek so a presentation that beats `seeked` is caught.
  const handle = video.requestVideoFrameCallback((_now, m) => {
    meta = m;
    rvfcAt = performance.now();
    done();
  });
  const t0 = performance.now();
  const seeked = once(video, 'seeked');
  video.currentTime = t;
  await seeked;
  const tSeeked = performance.now();
  const msSeeked = tSeeked - t0;
  const currentTime = video.currentTime;
  const gotSeeked = probe.read(video, v).value;
  // The window opens now, at `seeked` (B2).
  const timer = setTimeout(() => {
    video.cancelVideoFrameCallback(handle);
    done();
  }, RVFC_WINDOW_MS);
  await rvfc;
  clearTimeout(timer);
  const msFrame = performance.now() - t0;
  const got = probe.read(video, v).value;
  const m = meta as VideoFrameCallbackMetadata | null;
  const near = m === null ? { frame: -1, errUs: 0 } : nearestFrame(v, m.mediaTime * 1e6);
  return {
    target: op.target,
    policy: op.policy,
    requestedTime: t,
    gotSeeked,
    got,
    currentTime,
    msSeeked,
    msFrame,
    rvfcFired: m !== null,
    msRvfcAfterSeeked: m === null ? null : rvfcAt - tSeeked,
    mediaTimeFrame: near.frame,
    mediaTime: m === null ? -1 : m.mediaTime,
    mediaTimeErrUs: near.errUs,
  };
}

async function videoElementRun(name: string, ops: readonly VideoOp[]): Promise<VideoOpResult[]> {
  const v = (await getManifest())[name];
  if (v === undefined) throw new Error(`unknown video ${name}`);
  await openVideo(v);
  const out: VideoOpResult[] = [];
  for (const op of ops) out.push(await seekOp(v, op));
  return out;
}

interface WebCodecsRunResult {
  results: WebCodecsOpResult[];
  demuxMs: number;
  stats: WebCodecsFrameSource['stats'] | null;
  peakCacheBytes: number;
  peakCacheFrames: number;
  frameBytes: number;
  tableMaxErrUs: number;
  codec: string;
}

/**
 * Frame requests through one of two decode paths over the same mediabunny
 * demux: `@osdlabel/video`'s WebCodecsFrameSource (`kind: 'webcodecs'`), or
 * mediabunny's VideoSampleSink.getSample at the frame's own timestamp
 * (`kind: 'sink'`, no cache).
 */
async function decodeRun(
  name: string,
  targets: readonly number[],
  cacheFrames: number,
  kind: 'webcodecs' | 'sink',
): Promise<WebCodecsRunResult> {
  const v = (await getManifest())[name];
  if (v === undefined) throw new Error(`unknown video ${name}`);
  let wc: WebCodecsFrameSource | null = null;
  let demuxer: MediabunnyDemuxer;
  let getFrame: (i: number) => Promise<VideoFrame>;
  let timestampsUs: readonly number[];
  if (kind === 'webcodecs') {
    const opened = await openFrameSource(mediaUrl(v), {
      cacheFrames,
      cacheBytes: 2 * 1024 ** 3,
    });
    wc = opened.source;
    demuxer = opened.demuxer;
    const src = opened.source;
    getFrame = (i) => src.getFrame(i);
    timestampsUs = src.timestampsUs;
  } else {
    demuxer = await MediabunnyDemuxer.open(mediaUrl(v));
    const sink = new MediabunnySampleFrameSource(demuxer);
    getFrame = (i) => sink.getFrame(i);
    timestampsUs = sink.timestampsUs;
  }
  try {
    // Does the demuxer's table agree with ffprobe's ground truth?
    let tableMaxErrUs = 0;
    for (let i = 0; i < v.frameCount; i++) {
      tableMaxErrUs = Math.max(tableMaxErrUs, Math.abs((timestampsUs[i] ?? NaN) - v.ptsUs[i]!));
    }
    const results: WebCodecsOpResult[] = [];
    let frameBytes = 0;
    for (const target of targets) {
      const resets = wc?.stats.resets ?? 0;
      const hits = wc?.stats.cacheHits ?? 0;
      const t0 = performance.now();
      const frame = await getFrame(target);
      const ms = performance.now() - t0;
      frameBytes = frame.allocationSize();
      const got = probe.read(frame, v).value;
      frame.close();
      results.push({
        target,
        got,
        ms,
        reset: wc !== null && wc.stats.resets > resets,
        hit: wc !== null && wc.stats.cacheHits > hits,
      });
    }
    return {
      results,
      demuxMs: demuxer.demuxMs,
      stats: wc === null ? null : { ...wc.stats },
      peakCacheBytes: wc?.cache.peakBytes ?? 0,
      peakCacheFrames: wc?.cache.peakEntries ?? 0,
      frameBytes,
      tableMaxErrUs,
      codec: demuxer.decoderConfig.codec,
    };
  } finally {
    wc?.close();
    demuxer.close();
  }
}

const webcodecsRun = (
  name: string,
  targets: readonly number[],
  cacheFrames: number,
): Promise<WebCodecsRunResult> => decodeRun(name, targets, cacheFrames, 'webcodecs');
const sinkRun = (name: string, targets: readonly number[]): Promise<WebCodecsRunResult> =>
  decodeRun(name, targets, 0, 'sink');

export interface PauseSample {
  /** `video.currentTime` after the pause: what an app saving currentTime stores. */
  readonly currentTime: number;
  /** Barcode on screen after the pause: the frame the user saw. */
  readonly got: number;
  /** rVFC mediaTime of the last frame presented before the pause, seconds (-1 if none). */
  readonly lastMediaTime: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const twoFrames = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Play from a random position, pause after a random 80-480 ms, and record
 * `currentTime` with the frame on screen. `n` pauses per video.
 */
async function playPauseRun(name: string, n: number, seed = 11): Promise<PauseSample[]> {
  const v = (await getManifest())[name];
  if (v === undefined) throw new Error(`unknown video ${name}`);
  await openVideo(v);
  const rnd = mulberry32(seed);
  const dur = v.ptsUs[v.frameCount - 1]! / 1e6;
  const out: PauseSample[] = [];
  let lastMediaTime: number;
  let playing = false;
  const onFrame = (_now: number, m: VideoFrameCallbackMetadata): void => {
    lastMediaTime = m.mediaTime;
    if (playing) video.requestVideoFrameCallback(onFrame);
  };
  for (let k = 0; k < n; k++) {
    const seeked = once(video, 'seeked');
    video.currentTime = rnd() * (dur - 1);
    await seeked;
    lastMediaTime = -1;
    playing = true;
    video.requestVideoFrameCallback(onFrame);
    await video.play();
    await sleep(80 + rnd() * 400);
    playing = false;
    video.pause();
    await twoFrames();
    await sleep(50);
    out.push({ currentTime: video.currentTime, got: probe.read(video, v).value, lastMediaTime });
  }
  return out;
}

async function selfTest(name = 'h264-720p-30-g30-bf'): Promise<unknown> {
  const targets = [0, 1, 2, 29, 30, 31, 150, 149, 148, 299];
  const ve = await videoElementRun(
    name,
    targets.map((target) => ({ target, policy: 'boundary' as const })),
  );
  const wc = await webcodecsRun(name, targets, 8);
  const summary = {
    videoElementBoundaryExact: ve.filter((r) => r.got === r.target).length,
    webcodecsExact: wc.results.filter((r) => r.got === r.target).length,
    of: targets.length,
  };
  (document.getElementById('log') as HTMLElement).textContent = JSON.stringify(summary, null, 1);
  return summary;
}

declare global {
  interface Window {
    __seek: {
      manifest: () => Promise<Manifest>;
      videoElementRun: typeof videoElementRun;
      webcodecsRun: typeof webcodecsRun;
      sinkRun: typeof sinkRun;
      playPauseRun: typeof playPauseRun;
      selfTest: typeof selfTest;
      env: () => Record<string, unknown>;
    };
  }
}

window.__seek = {
  manifest: getManifest,
  videoElementRun,
  webcodecsRun,
  sinkRun,
  playPauseRun,
  selfTest,
  env: () => ({
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    webCodecs: typeof VideoDecoder !== 'undefined',
    rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }),
};
