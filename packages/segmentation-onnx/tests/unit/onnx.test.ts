import { describe, expect, it } from 'vitest';
import { modelFrame, modelGridFrame, type EncodeView } from '@osdlabel/segmentation';
import {
  EFFICIENT_SAM,
  SAM1,
  SAM2,
  alignPreviousMask,
  maskInputFeeds,
  orderCandidates,
  rgbaToChw,
  samEmbeddingFromTensors,
  type OrtModuleLike,
  type OrtSessionLike,
  type OrtTensorLike,
  type SamEmbedding,
} from '../../src/index.js';

class FakeTensor implements OrtTensorLike {
  constructor(
    readonly type: string,
    readonly data: Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

const ort: OrtModuleLike<FakeTensor> = {
  createSession: () => Promise.reject(new Error('not used')),
  float32: (data, dims) => new FakeTensor('float32', data, dims),
  int64: (data, dims) => new FakeTensor('int64', data, dims),
};

const session = (inputNames: string[]): OrtSessionLike<FakeTensor> => ({
  inputNames,
  outputNames: [],
  run: () => Promise.resolve({}),
  release: () => Promise.resolve(),
});

const view: EncodeView = {
  imageKey: 'img',
  imageSize: { width: 100_000, height: 80_000 },
  region: { x: 10_000, y: 20_000, width: 16_384, height: 9_216 },
  scale: 1024 / 16_384,
};

function embedding(family: 'sam1' | 'efficientsam' | 'sam2'): SamEmbedding {
  return {
    family,
    frame: modelFrame(view, 1024, family === 'sam1' ? 'letterbox' : 'stretch'),
    tensors: [
      { name: 'image_embeddings', dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64) },
    ],
  };
}

describe('preprocess', () => {
  it('normalises with ImageNet statistics and pads with zeros', () => {
    const data = new Uint8ClampedArray([124, 116, 104, 255]);
    const t = rgbaToChw({ width: 1, height: 1, data }, 2, 'imagenet');
    expect(t[0]).toBeCloseTo((124 / 255 - 0.485) / 0.229, 5);
    expect(t[1]).toBe(0); // padding
  });
});

describe('SAM1 decoder feeds', () => {
  it('maps image-space prompts into the letterboxed model frame with a pad point', () => {
    const feeds = SAM1.decoderFeeds(
      ort,
      session(['image_embeddings', 'point_coords']),
      embedding('sam1'),
      {
        points: [{ x: 10_000 + 8192, y: 20_000 + 4608, label: 1 }],
      },
    );
    const coords = feeds['point_coords']!.data as Float32Array;
    expect(Array.from(coords)).toEqual([512, 288, 0, 0]);
    expect(Array.from(feeds['point_labels']!.data as Float32Array)).toEqual([1, -1]);
    expect(feeds['orig_im_size']).toBeUndefined();
  });

  it('keeps the full graph upsample at model size, never image size', () => {
    const feeds = SAM1.decoderFeeds(
      ort,
      session(['image_embeddings', 'orig_im_size']),
      embedding('sam1'),
      {
        box: { x: 10_000, y: 20_000, width: 1600, height: 1600 },
      },
    );
    expect(Array.from(feeds['orig_im_size']!.data as Float32Array)).toEqual([576, 1024]);
    expect(Array.from(feeds['point_labels']!.data as Float32Array)).toEqual([2, 3]);
  });

  it('orders SAM outputs: multimask first for one click, single-mask first otherwise', () => {
    const planes = new Float32Array(4 * 256 * 256);
    const outputs = {
      low_res_masks: new FakeTensor('float32', planes, [1, 4, 256, 256]),
      iou_predictions: new FakeTensor('float32', Float32Array.from([0.5, 0.7, 0.9, 0.8]), [1, 4]),
    };
    const one = SAM1.candidates(outputs, embedding('sam1'), { points: [{ x: 1, y: 1, label: 1 }] });
    expect(one.map((c) => c.predictedIou)).toEqual([0.9, 0.8, 0.7, 0.5].map((v) => Math.fround(v)));
    const many = SAM1.candidates(outputs, embedding('sam1'), {
      points: [
        { x: 1, y: 1, label: 1 },
        { x: 2, y: 2, label: 0 },
      ],
    });
    expect(many[0]!.predictedIou).toBe(Math.fround(0.5));
    // Letterboxed 16:9 crop -> the low-res grid is cropped to 256 x 144.
    expect(one[0]!.mask.frame.width).toBe(256);
    expect(one[0]!.mask.frame.height).toBe(144);
    expect(one[0]!.mask.data.length).toBe(256 * 144);
  });

  it('keeps and ranks every candidate of a multimask-only export (3 outputs)', () => {
    // The SAM 2 decoder shipped with @annotorious/plugin-segment-anything has
    // no single-mask output: 3 planes. Before the fix only the first was kept.
    const planes = new Float32Array(3 * 256 * 256);
    const outputs = {
      masks: new FakeTensor('float32', planes, [1, 3, 256, 256]),
      iou_predictions: new FakeTensor('float32', Float32Array.from([0.4, 0.9, 0.6]), [1, 3]),
    };
    const out = SAM2.candidates(outputs, embedding('sam2'), { points: [{ x: 1, y: 1, label: 1 }] });
    expect(out.map((c) => c.predictedIou)).toEqual([0.9, 0.6, 0.4].map((v) => Math.fround(v)));
    expect(orderCandidates(Float32Array.from([0.2]), 1, {})).toEqual([0]);
  });
});

describe('mask_input feedback', () => {
  const emb = embedding('sam1');
  const grid = modelGridFrame(emb.frame, 256);
  const point = { x: 12_000, y: 22_000, label: 1 as const };
  const logits = (w: number, h: number): Float32Array => new Float32Array(w * h).fill(4);

  it("feeds the previous logits back only on this embedding's own grid", () => {
    const same = maskInputFeeds(
      ort,
      { points: [point], previous: { frame: grid, data: logits(grid.width, grid.height) } },
      emb,
    );
    expect(Array.from(same.has_mask_input.data as Float32Array)).toEqual([1]);
    expect((same.mask_input.data as Float32Array)[0]).toBe(4);
  });

  it('drops a previous result from another encode instead of misaligning it', () => {
    // The same grid size, but placed elsewhere: what a re-encode after a pan
    // or zoom produces. Before the fix only the size was checked.
    const moved = { ...grid, originX: grid.originX + 4 * grid.pixelWidth };
    const coarser = { ...grid, pixelWidth: grid.pixelWidth * 4, pixelHeight: grid.pixelHeight * 4 };
    for (const frame of [moved, coarser]) {
      const f = maskInputFeeds(
        ort,
        { points: [point], previous: { frame, data: logits(frame.width, frame.height) } },
        emb,
      );
      expect(Array.from(f.has_mask_input.data as Float32Array)).toEqual([0]);
      expect((f.mask_input.data as Float32Array).every((v) => v === 0)).toBe(true);
    }
  });

  it('resamples a result from another grid onto this one (default), or drops it', () => {
    // The previous result: a coarser grid over a larger region, foreground in
    // one block. After resampling, the logits sit on this embedding's grid at
    // the same image place.
    const coarse = {
      originX: grid.originX - 1000,
      originY: grid.originY - 1000,
      pixelWidth: grid.pixelWidth * 2,
      pixelHeight: grid.pixelHeight * 2,
      width: 200,
      height: 200,
    };
    const data = new Float32Array(200 * 200).fill(-8);
    const fg = { x: 18_000, y: 24_000 }; // inside the view
    const u = Math.floor((fg.x - coarse.originX) / coarse.pixelWidth);
    const v = Math.floor((fg.y - coarse.originY) / coarse.pixelHeight);
    for (let dv = -3; dv <= 3; dv++)
      for (let du = -3; du <= 3; du++) data[(v + dv) * 200 + u + du] = 6;
    const prompt = { points: [point], previous: { frame: coarse, data } };

    const resampled = alignPreviousMask(prompt, emb, 'resample');
    expect(resampled.previous!.frame).toEqual(grid);
    const g = resampled.previous!.data as Float32Array;
    const gu = Math.floor((fg.x - grid.originX) / grid.pixelWidth);
    const gv = Math.floor((fg.y - grid.originY) / grid.pixelHeight);
    expect(g[gv * grid.width + gu]).toBeCloseTo(6);
    expect(g[0]).toBeCloseTo(-8);
    const fed = maskInputFeeds(ort, resampled, emb);
    expect(Array.from(fed.has_mask_input.data as Float32Array)).toEqual([1]);

    expect(alignPreviousMask(prompt, emb, 'drop').previous).toBeUndefined();
    const onGrid = {
      points: [point],
      previous: { frame: grid, data: logits(grid.width, grid.height) },
    };
    expect(alignPreviousMask(onGrid, emb, 'resample')).toBe(onGrid);
  });
});

describe('EfficientSAM decoder feeds', () => {
  it('expresses points in the 256-px output space with int64 orig size', () => {
    const feeds = EFFICIENT_SAM.decoderFeeds(ort, session([]), embedding('efficientsam'), {
      points: [{ x: 10_000 + 8192, y: 20_000 + 4608, label: 1 }],
    });
    expect(Array.from(feeds['batched_point_coords']!.data as Float32Array)).toEqual([128, 128]);
    expect(Array.from(feeds['orig_im_size']!.data as BigInt64Array)).toEqual([256n, 256n]);
  });
});

describe('samEmbeddingFromTensors (received from a server)', () => {
  it('places the tensors for the view in the family layout and checks them', () => {
    const data = new Float32Array(256 * 64 * 64);
    const tensors = [
      { name: 'other', dims: [1], data: new Uint8Array(1) },
      { name: 'image_embeddings', dims: [1, 256, 64, 64], data },
    ];
    const e = samEmbeddingFromTensors('sam1', view, 1024, tensors);
    expect(e.frame).toEqual(modelFrame(view, 1024, 'letterbox'));
    expect(e.tensors.map((t) => t.name)).toEqual(['image_embeddings']);
    expect(e.tensors[0]!.data).toBe(data);
    // SAM 2 names its tensors differently and needs two high-res feature maps too.
    expect(() => samEmbeddingFromTensors('sam2', view, 1024, tensors)).toThrow(/'image_embed'/);
    const sam2Main = [{ name: 'image_embed', dims: [1, 256, 64, 64], data }];
    expect(() => samEmbeddingFromTensors('sam2', view, 1024, sam2Main)).toThrow(
      /'high_res_feats_0'/,
    );
    expect(() =>
      samEmbeddingFromTensors('sam1', view, 1024, [
        { name: 'image_embeddings', dims: [1], data: new Uint8Array(1) },
      ]),
    ).toThrow(/float32/);
  });
});
