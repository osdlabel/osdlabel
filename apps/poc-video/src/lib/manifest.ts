import { readFrameCode } from './frame-code.js';
import type { FrameCodeResult } from './frame-code.js';

/** One entry of media/manifest.json, written by scripts/gen-videos.py. */
export interface VideoInfo {
  readonly name: string;
  readonly file: string;
  readonly codec: 'h264' | 'vp9' | 'av1';
  readonly container: 'mp4' | 'webm';
  readonly width: number;
  readonly height: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly gop: number;
  readonly bframes: number;
  readonly vfr: boolean;
  readonly bytes: number;
  readonly frameCount: number;
  /** ffprobe ground truth, presentation order. */
  readonly ptsUs: readonly number[];
  readonly keyframes: readonly number[];
  readonly layout: {
    readonly bits: number;
    readonly bandH: number;
    readonly blockW: number;
    readonly marker: { readonly x: number; readonly y: number; readonly size: number };
  };
}

export type Manifest = Readonly<Record<string, VideoInfo>>;

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch('/media/manifest.json');
  if (!r.ok) throw new Error('media/manifest.json missing: run `pnpm gen` first');
  return (await r.json()) as Manifest;
}

export const mediaUrl = (v: VideoInfo): string => `/media/${v.file}`;

const PROBE_W = 128;
const PROBE_H = 16;

/** Reads the burned-in frame index from anything drawable (video, VideoFrame, canvas). */
export class FrameProbe {
  private readonly _ctx: CanvasRenderingContext2D;

  constructor(canvas?: HTMLCanvasElement) {
    const c = canvas ?? document.createElement('canvas');
    c.width = PROBE_W;
    c.height = PROBE_H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('2d context unavailable');
    this._ctx = ctx;
  }

  read(source: CanvasImageSource, v: VideoInfo): FrameCodeResult {
    this._ctx.drawImage(source, 0, 0, v.width, 2 * v.layout.bandH, 0, 0, PROBE_W, PROBE_H);
    const img = this._ctx.getImageData(0, 0, PROBE_W, PROBE_H);
    return readFrameCode({ data: img.data, width: PROBE_W, height: PROBE_H }, v.layout.bits);
  }
}
