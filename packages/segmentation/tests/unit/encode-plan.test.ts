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

function target(
  x: number,
  y: number,
  w: number,
  h: number,
  viewportScale: number,
): SegmentationTarget {
  return {
    imageKey: 'img',
    imageSize: IMAGE,
    viewport: { x, y, width: w, height: h },
    viewportScale,
  };
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
    expect(canReuse(view, target(41_000, 31_000, 16_000, 9_000, 1 / 16), null)).toEqual({
      reuse: true,
    });
  });

  it('never reuses across variants, and treats "no variant" as its own variant', () => {
    const ct = planEncodeView({ ...t0, variant: 'wl=40/400' });
    expect(ct.variant).toBe('wl=40/400');
    expect(canReuse(ct, { ...t0, variant: 'wl=40/400' }, null)).toEqual({ reuse: true });
    expect(canReuse(ct, { ...t0, variant: 'wl=-600/1500' }, null)).toEqual({
      reuse: false,
      reason: 'other-variant',
    });
    expect(canReuse(ct, t0, null)).toEqual({ reuse: false, reason: 'other-variant' });
    expect(canReuse(view, { ...t0, variant: 'wl=40/400' }, null)).toEqual({
      reuse: false,
      reason: 'other-variant',
    });
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
            frame: {
              originX: encoded.view.region.x,
              originY: encoded.view.region.y,
              pixelWidth: 1,
              pixelHeight: 1,
              width: 1,
              height: 1,
            },
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
    await provider.segment(
      target(60_000, 30_000, 16_000, 9_000, 1 / 16),
      { points: [{ x: 66_000, y: 34_000, label: 1 }] },
      signal,
    );
    expect(log).toHaveLength(2);
  });

  it('keys embeddings by variant: a new window/level or slice re-encodes, returning to one reuses it', async () => {
    const log: EncodeView[] = [];
    const provider = composeSegmentationProvider(fakeEncoder(log), decoder);
    const signal = new AbortController().signal;
    const at = (variant: string): SegmentationTarget => ({
      ...target(40_000, 30_000, 16_000, 9_000, 1 / 16),
      variant,
    });
    const p = { points: [{ x: 48_000, y: 34_000, label: 1 as const }] };
    await provider.segment(at('wl=40/400;z=12'), p, signal);
    await provider.segment(at('wl=40/400;z=12'), p, signal);
    expect(log).toHaveLength(1);
    expect(log[0]!.variant).toBe('wl=40/400;z=12');
    const lung = await provider.segment(at('wl=-600/1500;z=12'), p, signal);
    const slice = await provider.segment(at('wl=40/400;z=13'), p, signal);
    expect(lung.cached).toBe(false);
    expect(slice.cached).toBe(false);
    expect(log).toHaveLength(3);
    expect((await provider.segment(at('wl=40/400;z=12'), p, signal)).cached).toBe(true);
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

describe('refinement after a view change', () => {
  // The review's probe: click A at overview, zoom 4x onto a region that no
  // longer shows A, then refine with B, C, D. Before the fix every refinement
  // re-encoded (4 encodes for 4 clicks) and A lay outside every encoded region.
  const overview = target(30_000, 30_000, 40_000, 25_000, 1280 / 40_000);
  const zoomed = target(58_000, 38_000, 10_000, 6_250, 1280 / 10_000);
  const A = { x: 35_000, y: 40_000, label: 1 as const };
  const B = { x: 62_000, y: 41_000, label: 1 as const };
  const C = { x: 63_000, y: 41_500, label: 0 as const };
  const D = { x: 62_500, y: 40_500, label: 1 as const };
  const inside = (v: EncodeView, p: { x: number; y: number }): boolean =>
    p.x >= v.region.x &&
    p.y >= v.region.y &&
    p.x <= v.region.x + v.region.width &&
    p.y <= v.region.y + v.region.height;

  it('plans a region that covers prompts outside the viewport, plus the margin', () => {
    const v = planEncodeView(zoomed, DEFAULT_ENCODE_POLICY, { points: [A, B] });
    expect(inside(v, A)).toBe(true);
    expect(inside(v, B)).toBe(true);
    // A is padded by the same margin the viewport gets (0.25 x 10_000).
    expect(v.region.x).toBe(A.x - 2_500);
    // Prompts inside the viewport leave the plan unchanged.
    expect(planEncodeView(zoomed, DEFAULT_ENCODE_POLICY, { points: [B] })).toEqual(
      planEncodeView(zoomed),
    );
  });

  it("covers the previous result's foreground: the object being refined", () => {
    const data = new Float32Array(16).fill(-5);
    data[5] = 3; // one foreground cell at (1, 1)
    const previous = {
      frame: {
        originX: 20_000,
        originY: 50_000,
        pixelWidth: 100,
        pixelHeight: 100,
        width: 4,
        height: 4,
      },
      data,
    };
    const v = planEncodeView(zoomed, DEFAULT_ENCODE_POLICY, { points: [B], previous });
    // Foreground cell (1,1) spans 20_100..20_200; logits spill half a cell.
    expect(v.region.x).toBeLessThanOrEqual(20_050 - 2_500);
    expect(v.region.y + v.region.height).toBeGreaterThanOrEqual(50_250);
  });

  it('encodes once for the refinement, then reuses it; every decode sees every point', async () => {
    const log: EncodeView[] = [];
    const seen: boolean[][] = [];
    const provider = composeSegmentationProvider(fakeEncoder(log), {
      ...decoder,
      async decode(encoded, prompt) {
        seen.push((prompt.points ?? []).map((p) => inside(encoded.view, p)));
        return decoder.decode(encoded, prompt, new AbortController().signal);
      },
    });
    const signal = new AbortController().signal;
    await provider.segment(overview, { points: [A] }, signal);
    await provider.segment(zoomed, { points: [A, B] }, signal);
    await provider.segment(zoomed, { points: [A, B, C] }, signal);
    await provider.segment(zoomed, { points: [A, B, C, D] }, signal);
    expect(log).toHaveLength(2);
    expect(provider.cache.size).toBe(2);
    expect(seen.flat().every(Boolean)).toBe(true);
  });

  it('never re-encodes on every click when no encode can be finer (viewport wider than 2048 px)', async () => {
    // 2560 screen px across 25_600 image px: the plan's scale is 1024 / 38_400,
    // 3.75x coarser than the screen, so the old rule rejected every embedding
    // as too coarse, including the one it had just made.
    const wide = target(40_000, 30_000, 25_600, 16_000, 0.1);
    const fresh = planEncodeView(wide);
    expect(wide.viewportScale / fresh.scale).toBeGreaterThan(DEFAULT_ENCODE_POLICY.maxZoomIn);
    expect(canReuse(fresh, wide, null)).toEqual({ reuse: true });
    const log: EncodeView[] = [];
    const provider = composeSegmentationProvider(fakeEncoder(log), decoder);
    const signal = new AbortController().signal;
    for (const x of [45_000, 50_000, 55_000]) {
      await provider.segment(wide, { points: [{ x, y: 38_000, label: 1 }] }, signal);
    }
    expect(log).toHaveLength(1);
  });

  it('still re-encodes a plain zoom-in that a fresh encode resolves finer', () => {
    const t0 = target(40_000, 30_000, 16_000, 9_000, 1 / 16);
    const view = planEncodeView(t0);
    const zoomedIn = target(46_000, 33_375, 4_000, 2_250, 1 / 4);
    expect(canReuse(view, zoomedIn, { points: [{ x: 47_000, y: 34_000, label: 1 }] })).toEqual({
      reuse: false,
      reason: 'too-coarse',
    });
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
