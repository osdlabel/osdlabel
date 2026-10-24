import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DemuxedPacket, Demuxer } from '../../src/index.js';
import { WebCodecsFrameSource } from '../../src/index.js';

/**
 * A stand-in for WebCodecs' VideoDecoder: frames come out in presentation
 * order with a one-frame reorder delay (as a decoder holds a reference frame
 * until it knows no B-frame precedes it), and only from a key packet after
 * `configure`. Enough to exercise the source's decode-from-key, continuation
 * and cache logic in Node, where WebCodecs does not exist.
 */
interface FakeChunk {
  readonly timestamp: number;
  readonly type: 'key' | 'delta';
}
class FakeFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  clone(): FakeFrame {
    return new FakeFrame(this.timestamp);
  }
  close(): void {
    this.closed = true;
  }
  allocationSize(): number {
    return 100;
  }
}
class FakeDecoder extends EventTarget {
  static decoded = 0;
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  decodeQueueSize = 0;
  private _held: FakeFrame[] = [];
  private _needKey = true;
  constructor(private readonly _init: { output: (f: FakeFrame) => void }) {
    super();
  }
  static isConfigSupported(): Promise<{ supported: boolean }> {
    return Promise.resolve({ supported: true });
  }
  configure(): void {
    this.state = 'configured';
    this._needKey = true;
  }
  reset(): void {
    this._held = [];
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
  decode(chunk: FakeChunk): void {
    if (this._needKey && chunk.type !== 'key') throw new Error('key frame required');
    this._needKey = false;
    FakeDecoder.decoded++;
    this.decodeQueueSize++;
    queueMicrotask(() => {
      this.decodeQueueSize--;
      this._held.push(new FakeFrame(chunk.timestamp));
      this._held.sort((a, b) => a.timestamp - b.timestamp);
      if (this._held.length > 1) this._init.output(this._held.shift()!);
      this.dispatchEvent(new Event('dequeue'));
    });
  }
  async flush(): Promise<void> {
    await Promise.resolve();
    for (const f of this._held.splice(0)) this._init.output(f);
  }
}

/** I0 P3 B1 B2 P6 B4 B5 | I7 P10 B8 B9: two closed GOPs with B-frames. */
function demuxer(): Demuxer {
  const order = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9];
  const packets: DemuxedPacket[] = order.map((f) => ({
    timestampUs: f * 1000,
    durationUs: 1000,
    key: f === 0 || f === 7,
  }));
  return {
    decoderConfig: { codec: 'fake' },
    displayWidth: 4,
    displayHeight: 4,
    packets,
    chunk: (j) =>
      ({
        timestamp: packets[j]!.timestampUs,
        type: packets[j]!.key ? 'key' : 'delta',
      }) as unknown as EncodedVideoChunk,
    close: () => {},
  };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: unknown;
beforeEach(() => {
  saved = g['VideoDecoder'];
  g['VideoDecoder'] = FakeDecoder;
  FakeDecoder.decoded = 0;
});
afterEach(() => {
  g['VideoDecoder'] = saved;
});

const index = async (src: WebCodecsFrameSource, i: number): Promise<number> => {
  const f = await src.getFrame(i);
  const t = f.timestamp / 1000;
  f.close();
  return t;
};

describe('WebCodecsFrameSource over a Demuxer', () => {
  it('returns every frame exactly, in any order, through B-frame reordering', async () => {
    const src = await WebCodecsFrameSource.create(demuxer(), { cacheFrames: 0, cacheBytes: 0 });
    expect(src.timestampsUs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => i * 1000));
    for (const i of [5, 0, 10, 2, 7, 6, 9, 1]) expect(await index(src, i)).toBe(i);
    src.close();
  });

  it('continues forward without restarting, restarts at the key packet going back', async () => {
    const src = await WebCodecsFrameSource.create(demuxer(), { cacheFrames: 0, cacheBytes: 0 });
    for (let i = 0; i <= 6; i++) expect(await index(src, i)).toBe(i);
    expect(src.stats.resets).toBe(1);
    expect(await index(src, 3)).toBe(3);
    expect(src.stats.resets).toBe(2);
    // Frame 9 is in the second GOP: decoding restarts at I7, not at I0.
    const before = FakeDecoder.decoded;
    expect(await index(src, 9)).toBe(9);
    expect(FakeDecoder.decoded - before).toBeLessThanOrEqual(4);
    src.close();
  });

  it('serves back-steps from the cache that one decode filled', async () => {
    const src = await WebCodecsFrameSource.create(demuxer(), { cacheFrames: 16, cacheBytes: 1e6 });
    expect(await index(src, 6)).toBe(6);
    const decoded = FakeDecoder.decoded;
    for (let i = 5; i >= 0; i--) expect(await index(src, i)).toBe(i);
    expect(FakeDecoder.decoded).toBe(decoded);
    expect(src.stats.cacheHits).toBe(6);
    src.close();
  });
});
