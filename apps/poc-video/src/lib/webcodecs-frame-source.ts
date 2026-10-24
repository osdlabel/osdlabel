import { ALL_FORMATS, EncodedPacketSink, Input, UrlSource } from 'mediabunny';
import type { FrameTable, PacketInfo } from './frame-table.js';
import { buildFrameTable, frameOfTimestamp, startKeyFor } from './frame-table.js';
import { LruCache } from './lru-cache.js';

export interface FrameSourceOptions {
  /** Decoded frames kept for re-use (stepping back, re-visits). 0 disables the cache. */
  readonly cacheFrames: number;
  /** Byte budget for the cache, measured with `VideoFrame.allocationSize()`. */
  readonly cacheBytes: number;
}

export interface FrameSourceStats {
  requests: number;
  cacheHits: number;
  /** Requests that restarted decoding at a keyframe. */
  resets: number;
  packetsFed: number;
  framesOutput: number;
  flushes: number;
}

/** Packets fed ahead of the decoder before waiting for it to drain. */
const MAX_QUEUE = 8;

/**
 * Frame-exact random access to a video file: demux once with mediabunny
 * (MP4 and WebM), then decode with WebCodecs `VideoDecoder` from the key
 * packet preceding the requested frame. Frames are addressed by presentation
 * index, never by time, so there is no rounding to land on a neighbour.
 *
 * Decoding continues forward from where the last request left off when it
 * can (stepping forward or playing costs one frame each); stepping back or
 * jumping restarts at the nearest key packet, and an LRU of decoded frames
 * absorbs repeat visits.
 */
export class WebCodecsFrameSource {
  readonly stats: FrameSourceStats = {
    requests: 0,
    cacheHits: 0,
    resets: 0,
    packetsFed: 0,
    framesOutput: 0,
    flushes: 0,
  };
  readonly cache: LruCache<number, VideoFrame>;

  private readonly _decoder: VideoDecoder;
  /** prefix max of decode index over presentation order */
  private readonly _needDecode: number[];
  private _nextDecode = 0;
  private _lastOutput = -1;
  private _active = false;
  private _error: Error | null = null;
  /** The frame the current request waits for, pinned outside the cache. */
  private _want = -1;
  private _got: VideoFrame | null = null;
  private _waiters: (() => void)[] = [];
  private _busy: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly table: FrameTable,
    private readonly _chunks: readonly EncodedVideoChunk[],
    readonly config: VideoDecoderConfig,
    readonly width: number,
    readonly height: number,
    readonly demuxMs: number,
    options: FrameSourceOptions,
  ) {
    this.cache = new LruCache<number, VideoFrame>(options.cacheFrames, options.cacheBytes, (f) =>
      f.close(),
    );
    this._needDecode = new Array<number>(table.frameCount);
    let m = -1;
    for (let i = 0; i < table.frameCount; i++) {
      m = Math.max(m, table.frames[i]!.decodeIndex);
      this._needDecode[i] = m;
    }
    this._decoder = new VideoDecoder({
      output: (frame) => this._onOutput(frame),
      error: (e) => {
        this._error = e instanceof Error ? e : new Error(String(e));
        this._wake();
      },
    });
    this._decoder.addEventListener('dequeue', () => this._wake());
  }

  static async open(url: string, options: FrameSourceOptions): Promise<WebCodecsFrameSource> {
    const t0 = performance.now();
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (track === null) throw new Error(`${url}: no video track`);
    const config = await track.getDecoderConfig();
    if (config === null) throw new Error(`${url}: codec not decodable`);
    const support = await VideoDecoder.isConfigSupported(config);
    if (support.supported !== true) throw new Error(`${url}: ${config.codec} not supported`);
    const sink = new EncodedPacketSink(track);
    const chunks: EncodedVideoChunk[] = [];
    const infos: PacketInfo[] = [];
    for await (const packet of sink.packets()) {
      const chunk = packet.toEncodedVideoChunk();
      infos.push({
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? 0,
        key: chunk.type === 'key',
        decodeIndex: chunks.length,
      });
      chunks.push(chunk);
    }
    const demuxMs = performance.now() - t0;
    return new WebCodecsFrameSource(
      buildFrameTable(infos),
      chunks,
      config,
      track.displayWidth,
      track.displayHeight,
      demuxMs,
      options,
    );
  }

  get frameCount(): number {
    return this.table.frameCount;
  }

  /**
   * Frame `i` in presentation order. The caller owns the returned frame and
   * must `close()` it. Requests are serialised.
   */
  getFrame(i: number): Promise<VideoFrame> {
    const run = this._busy.then(() => this._getFrame(i));
    this._busy = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.cache.clear();
    if (this._decoder.state !== 'closed') this._decoder.close();
  }

  private _onOutput(frame: VideoFrame): void {
    this.stats.framesOutput++;
    const idx = frameOfTimestamp(this.table, frame.timestamp);
    if (idx < 0) {
      frame.close();
    } else {
      this._lastOutput = idx;
      if (idx === this._want && this._got === null) this._got = frame.clone();
      this.cache.set(idx, frame, frame.allocationSize());
    }
    this._wake();
  }

  private _wake(): void {
    const w = this._waiters;
    this._waiters = [];
    for (const r of w) r();
  }

  private _progress(): Promise<void> {
    return new Promise((r) => this._waiters.push(r));
  }

  private _feed(): void {
    const chunk = this._chunks[this._nextDecode++]!;
    this._decoder.decode(chunk);
    this.stats.packetsFed++;
  }

  private async _getFrame(i: number): Promise<VideoFrame> {
    if (i < 0 || i >= this.table.frameCount) throw new RangeError(`frame ${i}`);
    this.stats.requests++;
    const hit = this.cache.get(i);
    if (hit !== undefined) {
      this.stats.cacheHits++;
      return hit.clone();
    }
    const key = startKeyFor(this.table, i);
    const canContinue = this._active && i > this._lastOutput && key <= this._nextDecode;
    if (!canContinue) {
      this.stats.resets++;
      if (this._decoder.state === 'configured') this._decoder.reset();
      this._decoder.configure(this.config);
      this._nextDecode = key;
      this._lastOutput = -1;
      this._active = true;
    }
    const need = this._needDecode[i]!;
    const n = this._chunks.length;
    this._want = i;
    this._got = null;
    while (this._got === null) {
      if (this._error !== null) throw this._error;
      if (this._nextDecode <= need) {
        if (this._decoder.decodeQueueSize >= MAX_QUEUE) await this._progress();
        else this._feed();
        continue;
      }
      if (this._decoder.decodeQueueSize > 0) {
        await this._progress();
        continue;
      }
      if (this._nextDecode < n) {
        // Everything the target depends on is in; the decoder is holding it
        // back for reordering until it sees more input.
        this._feed();
        await this._progress();
        continue;
      }
      this.stats.flushes++;
      await this._decoder.flush();
      this._active = false;
      if (this._got === null) throw new Error(`frame ${i} was not produced`);
    }
    const got: VideoFrame = this._got;
    this._want = -1;
    this._got = null;
    return got;
  }
}
