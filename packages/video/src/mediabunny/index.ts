/**
 * `@osdlabel/video/mediabunny`: the {@link Demuxer} adapter over mediabunny,
 * and a frame source built on mediabunny's own `VideoSampleSink`.
 *
 * mediabunny is an optional peer dependency of `@osdlabel/video`; only this
 * entry point imports it, so an app with another demuxer never bundles it.
 * The input formats default to MP4 and WebM rather than `ALL_FORMATS`, which
 * keeps the parsers for formats a video annotator does not read out of the
 * bundle.
 */
import {
  BlobSource,
  EncodedPacketSink,
  Input,
  MP4,
  UrlSource,
  VideoSampleSink,
  WEBM,
} from 'mediabunny';
import type { EncodedPacket, InputFormat, InputVideoTrack } from 'mediabunny';
import type { DemuxedPacket, Demuxer } from '../demuxer.js';

export interface MediabunnyDemuxerOptions {
  /** Container formats to probe. Default `[MP4, WEBM]`. */
  readonly formats?: readonly InputFormat[];
}

/** A whole-file demux: every packet read up front (lazy, indexed access is an open question). */
export class MediabunnyDemuxer implements Demuxer {
  private constructor(
    readonly input: Input,
    readonly track: InputVideoTrack,
    readonly decoderConfig: VideoDecoderConfig,
    private readonly _packets: readonly EncodedPacket[],
    readonly packets: readonly DemuxedPacket[],
    /** Wall time of the whole demux, ms. */
    readonly demuxMs: number,
  ) {}

  static async open(
    src: string | Blob,
    options: MediabunnyDemuxerOptions = {},
  ): Promise<MediabunnyDemuxer> {
    const t0 = performance.now();
    const input = new Input({
      source: typeof src === 'string' ? new UrlSource(src) : new BlobSource(src),
      formats: [...(options.formats ?? [MP4, WEBM])],
    });
    const track = await input.getPrimaryVideoTrack();
    if (track === null) throw new Error('no video track');
    const config = await track.getDecoderConfig();
    if (config === null) throw new Error(`codec ${String(track.codec)} has no decoder config`);
    const encoded: EncodedPacket[] = [];
    const packets: DemuxedPacket[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
      encoded.push(packet);
      packets.push({
        timestampUs: packet.microsecondTimestamp,
        durationUs: packet.microsecondDuration,
        key: packet.type === 'key',
      });
    }
    return new MediabunnyDemuxer(input, track, config, encoded, packets, performance.now() - t0);
  }

  get displayWidth(): number {
    return this.track.displayWidth;
  }

  get displayHeight(): number {
    return this.track.displayHeight;
  }

  chunk(j: number): EncodedVideoChunk {
    const p = this._packets[j];
    if (p === undefined) throw new RangeError(`packet ${j}`);
    return p.toEncodedVideoChunk();
  }

  /** Presentation timestamps in seconds, as mediabunny reports them, presentation order. */
  presentationTimestampsS(): number[] {
    return this._packets.map((p) => p.timestamp).sort((a, b) => a - b);
  }

  close(): void {
    this.input.dispose();
  }
}

/**
 * Frame `i` through mediabunny's `VideoSampleSink.getSample(t)`, with `t`
 * the frame's own demuxed timestamp, so its "last sample at or before t"
 * lands on frame `i` exactly. No hand-written decoder loop, no cache: each
 * call is mediabunny's keyframe-aware seek. The PoC measures it against
 * {@link WebCodecsFrameSource} (`apps/poc-video` H1 `sink/*` cells).
 */
export class MediabunnySampleFrameSource {
  readonly timestampsUs: readonly number[];
  private readonly _timestampsS: readonly number[];
  private readonly _sink: VideoSampleSink;

  constructor(readonly demuxer: MediabunnyDemuxer) {
    this._timestampsS = demuxer.presentationTimestampsS();
    this.timestampsUs = demuxer.packets.map((p) => p.timestampUs).sort((a, b) => a - b);
    this._sink = new VideoSampleSink(demuxer.track);
  }

  get frameCount(): number {
    return this._timestampsS.length;
  }

  /** Frame `i` in presentation order; the caller closes it. */
  async getFrame(i: number): Promise<VideoFrame> {
    const t = this._timestampsS[i];
    if (t === undefined) throw new RangeError(`frame ${i}`);
    const sample = await this._sink.getSample(t);
    if (sample === null) throw new Error(`no sample at ${t} s`);
    try {
      return sample.toVideoFrame();
    } finally {
      sample.close();
    }
  }
}
