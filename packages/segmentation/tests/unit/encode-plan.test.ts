import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENCODE_POLICY,
  EmbeddingCache,
  canReuse,
  composeSegmentationProvider,
  planEncodeView,
  type EncodeView,
  type EncodedView,
  type SegmentationDecoder,
  type SegmentationEncoder,
  type SegmentationTarget,
} from '../../src/index.js';

const IMAGE = { width: 100_000, height: 80_000 };

function target(x: number, y: number, w: number, h: number, viewportScale: number): SegmentationTarget {
  return { imageKey: 'img', imageSize: IMAGE, viewport: { x, y, width: w, height: h }, viewportScale };
}

describe('planEncodeView', () => {
  it('adds the margin and fits the longer side into the model input', () => {
    // 1600x900 screen px at 1/16 zoom: viewport 25600 x 14400 image px.
    const t = target(40_000, 30_000, 25_600, 14_400, 1 / 16);
    const v = planEncodeView(t);
    expect(v.region.width).toBe(25_600 * 1.5);
    expect(v.region.height).toBe(14_400 * 1.5);
    expect(v.scale).toBeCloseTo(1024 / (25_600 * 1.5));
  });

  it('clips to the image', () => {
    const v = planEncodeView(target(0, 0, 10_000, 10_000, 0.1));
    expect(v.region.x).toBe(0);
    expect(v.region.y).toBe(0);
    expect(v.region.width).toBe(12_500);
  });

  it('never upsamples: zoomed past 1:1 the crop grows to inputSize image px', () => {
    const v = planEncodeView(target(5000, 5000, 400, 300, 4));
    expect(v.scale).toBe(1);
    expect(v.region.width).toBe(1024);
    expect(v.region.height).toBe(1024);
    // Still centred on the viewport.
    expect(v.region.x + v.region.width / 2).toBeCloseTo(5200, 0);
  });

  it('handles images smaller than the model input', () => {
    const t: SegmentationTarget = {
      imageKey: 's',
      imageSize: { width: 800, height: 600 },
      viewport: { x: 0, y: 0, width: 800, height: 600 },
      viewportScale: 1,
    };
    const v = planEncodeView(t);
    expect(v.region).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(v.scale).toBe(1);
  });
});

describe('canReuse', () => {
  const t0 = target(40_000, 30_000, 16_000, 9_000, 1 / 16);
  const view = planEncodeView(t0);

  it('reuses within the margin', () => {
    expect(canReuse(view, target(41_000, 31_000, 16_000, 9_000, 1 / 16), null)).toEqual({ reuse: true });
  });

  it('re-encodes when panned beyond the margin', () => {
    expect(canReuse(view, target(50_000, 30_000, 16_000, 9_000, 1 / 16), null)).toEqual({
      reuse: false,
      reason: 'panned-out',
    });
  });

  it('re-encodes when the prompt lies outside the encoded region', () => {
    const verdict = canReuse(view, t0, { points: [{ x: 1, y: 1, label: 1 }] });
    expect(verdict).toEqual({ reuse: false, reason: 'prompt-outside' });
  });

  it('re-encodes after zooming in past maxZoomIn', () => {
    // Zoom in 4x around the centre.
    const zoomed = target(46_000, 33_375, 4_000, 2_250, 1 / 4);
    expect(canReuse(view, zoomed, null)).toEqual({ reuse: false, reason: 'too-coarse' });
    const mild = target(44_000, 32_250, 8_000, 4_500, 1 / 8);
    expect(canReuse(view, mild, null, DEFAULT_ENCODE_POLICY).reuse).toBe(true);
  });
});

function fakeEncoder(log: EncodeView[]): SegmentationEncoder<string> {
  return {
    inputSize: 1024,
    async encode(view): Promise<EncodedView<string>> {
      log.push(view);
      return { view, embedding: `emb-${log.length}`, bytes: 4 << 20 };
    },
  };
}

const decoder: SegmentationDecoder<string> = {
  capabilities: { box: true, negativePoints: true, multimask: true, maskInput: false },
  async decode(encoded) {
    return {
      candidates: [
        {
          predictedIou: 0.9,
          mask: {
            frame: { originX: encoded.view.region.x, originY: encoded.view.region.y, pixelWidth: 1, pixelHeight: 1, width: 1, height: 1 },
            data: new Uint8Array([1]),
          },
        },
      ],
    };
  },
};

describe('composeSegmentationProvider', () => {
  it('encodes once per view and reuses across prompts and small pans', async () => {
    const log: EncodeView[] = [];
    const provider = composeSegmentationProvider(fakeEncoder(log), decoder);
    const signal = new AbortController().signal;
    const t = target(40_000, 30_000, 16_000, 9_000, 1 / 16);
    const p = { points: [{ x: 48_000, y: 34_000, label: 1 as const }] };
    const r1 = await provider.segment(t, p, signal);
    const r2 = await provider.segment(target(40_500, 30_200, 16_000, 9_000, 1 / 16), p, signal);
    expect(log).toHaveLength(1);
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    await provider.segment(target(60_000, 30_000, 16_000, 9_000, 1 / 16), { points: [{ x: 66_000, y: 34_000, label: 1 }] }, signal);
    expect(log).toHaveLength(2);
  });

  it('shares an in-flight encode between prepare and segment', async () => {
    const log: EncodeView[] = [];
    const provider = composeSegmentationProvider(fakeEncoder(log), decoder);
    const signal = new AbortController().signal;
    const t = target(40_000, 30_000, 16_000, 9_000, 1 / 16);
    await Promise.all([
      provider.prepare!(t, signal),
      provider.segment(t, { points: [{ x: 48_000, y: 34_000, label: 1 }] }, signal),
    ]);
    expect(log).toHaveLength(1);
  });
});

describe('EmbeddingCache eviction', () => {
  it('evicts least recently used settled entries beyond maxEntries', async () => {
    const cache = new EmbeddingCache<string>({ maxEntries: 2 });
    const log: EncodeView[] = [];
    const enc = fakeEncoder(log);
    for (const x of [0, 30_000, 60_000]) {
      const t = target(x, 0, 10_000, 10_000, 0.05);
      await cache.lookupOrEncode(t, null, planEncodeView(t), enc.encode.bind(enc)).entry;
    }
    expect(cache.size).toBe(2);
  });
});
