import { describe, it, expect } from 'vitest';
import { cocoRleCodec, encodeCanonical, runRaster, DEFAULT_MAX_MASK_PIXELS } from '@osdlabel/mask';
import { deserialize, serialize } from '../../src/serialization-configured.js';

/**
 * A document a later reader with sparse storage could write: one canonical
 * mask whose box is past the dense cap. The wire format and schema already
 * admit it, so a reader from before such storage existed loses only that
 * mask — named in `skipped` — never the document, and a host may raise its
 * own cap to keep it.
 */

// Two 10-cell dabs at opposite corners of a 13,000-square box: 169 M cells
// of box, 2.5x the dense cap, 20 painted. Built from runs, so nothing here
// allocates the box either.
const SIDE = 13_000;
const raster = runRaster(
  { x: 0, y: 0, width: SIDE, height: SIDE, imageWidth: 20_000, imageHeight: 20_000, downsample: 1 },
  [0, 10, SIDE - 10 + SIDE * (SIDE - 2) + SIDE - 10, 10],
);
const payload = encodeCanonical(raster);

const doc = [
  {
    id: 'big',
    imageId: 'img-1',
    contextId: 'ctx',
    toolType: 'segmentationBrush',
    geometry: { type: 'mask', origin: { x: 0, y: 0 }, width: SIDE, height: SIDE, pixelCount: 20 },
    rawAnnotationData: { format: 'osdlabel-mask', data: payload },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rect',
    imageId: 'img-1',
    contextId: 'ctx',
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0 },
    rawAnnotationData: {
      format: 'fabric',
      fabricVersion: '7.1.0',
      data: { id: 'rect', type: 'rect', left: 0, top: 0, width: 1, height: 1 },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('a document holding a mask past the dense cap', () => {
  it('is a small, ordinary payload', () => {
    expect(SIDE * SIDE).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
    expect(payload.counts.length).toBeLessThan(32);
  });

  it('costs a default reader that mask, not the document', () => {
    const { byImage, skipped } = deserialize(doc);
    expect(Object.keys(byImage['img-1' as never]!)).toEqual(['rect']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe('big');
    expect(skipped[0]!.reason).toMatch(/pixel cap/);
  });

  it('is kept, exact, by a host that raises its own cap', () => {
    const { byImage, skipped } = deserialize(doc, {
      maxMaskPixels: Number.POSITIVE_INFINITY,
      maxTotalMaskPixels: Number.POSITIVE_INFINITY,
    });
    expect(skipped).toEqual([]);
    const mask = byImage['img-1' as never]!['big' as never]!;
    expect(mask.geometry).toEqual({
      type: 'mask',
      origin: { x: 0, y: 0 },
      width: SIDE,
      height: SIDE,
      pixelCount: 20,
    });

    // And it exports to COCO from runs, without the box.
    const state = { byImage, changeCounter: 1 } as never;
    const exported = serialize(state, {
      maskCodec: cocoRleCodec,
      maxMaskPixels: Number.POSITIVE_INFINITY,
    }).find((a) => a.id === 'big')!;
    expect((exported.rawAnnotationData.data as { size: unknown }).size).toEqual([20_000, 20_000]);
  });
});
