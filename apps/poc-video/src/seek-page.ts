/**
 * H1 harness: is seeking frame-accurate?
 *
 * Two ways to put frame `i` on screen:
 *   - HTMLVideoElement: set `currentTime` (several policies for which time to
 *     ask for), wait for `seeked` and the next `requestVideoFrameCallback`.
 *   - WebCodecs: `WebCodecsFrameSource.getFrame(i)` (demux with mediabunny,
 *     decode from the preceding key packet).
 * Either way the burned-in barcode says which frame actually arrived.
 */
import { createTimestampAxis, frameAt } from '@osdlabel/temporal';
import type { Manifest, VideoInfo } from './lib/manifest.js';
import { FrameProbe, loadManifest, mediaUrl } from './lib/manifest.js';
import { WebCodecsFrameSource } from './lib/webcodecs-frame-source.js';

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
  /** Barcode read after the presented-frame callback (or a 250 ms timeout). */
  readonly got: number;
  readonly msSeeked: number;
  readonly msFrame: number;
  readonly rvfcFired: boolean;
  /** Frame whose pts matches rVFC metadata.mediaTime (nearest), -1 if no callback. */
  readonly mediaTimeFrame: number;
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
  const rvfc = new Promise<void>((resolve) => {
    const handle = video.requestVideoFrameCallback((_now, m) => {
      meta = m;
      resolve();
    });
    setTimeout(() => {
      video.cancelVideoFrameCallback(handle);
      resolve();
    }, 250);
  });
  const t0 = performance.now();
  const seeked = once(video, 'seeked');
  video.currentTime = t;
  await seeked;
  const msSeeked = performance.now() - t0;
  const gotSeeked = probe.read(video, v).value;
  await rvfc;
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
    msSeeked,
    msFrame,
    rvfcFired: m !== null,
    mediaTimeFrame: near.frame,
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

async function webcodecsRun(
  name: string,
  targets: readonly number[],
  cacheFrames: number,
): Promise<{
  results: WebCodecsOpResult[];
  demuxMs: number;
  stats: WebCodecsFrameSource['stats'];
  peakCacheBytes: number;
  peakCacheFrames: number;
  frameBytes: number;
  tableMaxErrUs: number;
  codec: string;
}> {
  const v = (await getManifest())[name];
  if (v === undefined) throw new Error(`unknown video ${name}`);
  const src = await WebCodecsFrameSource.open(mediaUrl(v), {
    cacheFrames,
    cacheBytes: 2 * 1024 ** 3,
  });
  try {
    // Does the demuxer's table agree with ffprobe's ground truth?
    let tableMaxErrUs = 0;
    for (let i = 0; i < v.frameCount; i++) {
      const a = src.table.frames[i]?.timestampUs ?? NaN;
      tableMaxErrUs = Math.max(tableMaxErrUs, Math.abs(a - v.ptsUs[i]!));
    }
    const results: WebCodecsOpResult[] = [];
    let frameBytes = 0;
    for (const target of targets) {
      const resets = src.stats.resets;
      const hits = src.stats.cacheHits;
      const t0 = performance.now();
      const frame = await src.getFrame(target);
      const ms = performance.now() - t0;
      frameBytes = frame.allocationSize();
      const got = probe.read(frame, v).value;
      frame.close();
      results.push({
        target,
        got,
        ms,
        reset: src.stats.resets > resets,
        hit: src.stats.cacheHits > hits,
      });
    }
    return {
      results,
      demuxMs: src.demuxMs,
      stats: { ...src.stats },
      peakCacheBytes: src.cache.peakBytes,
      peakCacheFrames: src.cache.peakEntries,
      frameBytes,
      tableMaxErrUs,
      codec: src.config.codec,
    };
  } finally {
    src.close();
  }
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
      selfTest: typeof selfTest;
      env: () => Record<string, unknown>;
    };
  }
}

window.__seek = {
  manifest: getManifest,
  videoElementRun,
  webcodecsRun,
  selfTest,
  env: () => ({
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    webCodecs: typeof VideoDecoder !== 'undefined',
    rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }),
};
