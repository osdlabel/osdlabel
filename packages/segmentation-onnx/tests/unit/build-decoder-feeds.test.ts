import { describe, it, expect } from 'vitest';
import { buildDecoderFeeds } from '../../src/build-decoder-feeds.js';
import type { SamEmbedding } from '../../src/sam-embedding.js';

const embedding: SamEmbedding = {
  embedding: { data: new Float32Array([1, 2, 3]), dims: [1, 256, 64, 64] },
  origWidth: 2000,
  origHeight: 1000,
  inputSize: 1024,
};
const SCALE = 1024 / 2000; // 0.512, longest-side fit

describe('buildDecoderFeeds', () => {
  it('encodes a box as TL(2)/BR(3) points in model space, with no padding point', () => {
    const feeds = buildDecoderFeeds(embedding, {
      box: { x: 100, y: 200, width: 300, height: 400 },
      points: [{ x: 50, y: 50, label: 1 }],
    });

    expect(feeds.point_labels!.data).toEqual(Float32Array.from([2, 3, 1]));
    expect(feeds.point_coords!.dims).toEqual([1, 3, 2]);
    const c = feeds.point_coords!.data;
    expect(c[0]).toBeCloseTo(100 * SCALE); // box TL x
    expect(c[1]).toBeCloseTo(200 * SCALE);
    expect(c[2]).toBeCloseTo(400 * SCALE); // box BR x (100+300)
    expect(c[3]).toBeCloseTo(600 * SCALE);
    expect(c[4]).toBeCloseTo(50 * SCALE); // fg point
    expect(c[5]).toBeCloseTo(50 * SCALE);
  });

  it('appends a (0,0) label -1 padding point when there is no box', () => {
    const feeds = buildDecoderFeeds(embedding, { points: [{ x: 10, y: 20, label: 1 }] });
    expect(feeds.point_labels!.data).toEqual(Float32Array.from([1, -1]));
    expect(feeds.point_coords!.dims).toEqual([1, 2, 2]);
    const c = feeds.point_coords!.data;
    expect(c[0]).toBeCloseTo(10 * SCALE);
    expect(c[1]).toBeCloseTo(20 * SCALE);
    expect(c[2]).toBe(0); // padding
    expect(c[3]).toBe(0);
  });

  it('carries background point labels through as 0', () => {
    const feeds = buildDecoderFeeds(embedding, {
      points: [
        { x: 1, y: 1, label: 1 },
        { x: 2, y: 2, label: 0 },
      ],
    });
    expect(feeds.point_labels!.data).toEqual(Float32Array.from([1, 0, -1]));
  });

  it('fills mask_input (zeros), has_mask_input ([0]) and orig_im_size ([H,W])', () => {
    const feeds = buildDecoderFeeds(embedding, { box: { x: 0, y: 0, width: 10, height: 10 } });
    expect(feeds.mask_input!.dims).toEqual([1, 1, 256, 256]);
    expect(feeds.mask_input!.data.length).toBe(256 * 256);
    expect(feeds.mask_input!.data.every((v) => v === 0)).toBe(true);
    expect(feeds.has_mask_input!.data).toEqual(Float32Array.from([0]));
    expect(feeds.orig_im_size!.data).toEqual(Float32Array.from([1000, 2000]));
    expect(feeds.image_embeddings).toBe(embedding.embedding);
  });

  it('honors custom input names', () => {
    const feeds = buildDecoderFeeds(
      embedding,
      { box: { x: 0, y: 0, width: 1, height: 1 } },
      {
        imageEmbeddings: 'emb',
        pointCoords: 'pc',
        pointLabels: 'pl',
        maskInput: 'mi',
        hasMaskInput: 'hmi',
        origImSize: 'ois',
      },
    );
    expect(Object.keys(feeds).sort()).toEqual(['emb', 'hmi', 'mi', 'ois', 'pc', 'pl']);
  });
});
