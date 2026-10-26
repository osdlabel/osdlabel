import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_MASK_PIXELS, decodeCanonicalRaster } from '@osdlabel/mask';
import { deserialize } from '../../src/serialization-configured.js';

/**
 * A document holding one canonical mask whose box is past the format's cap,
 * as a hand-edited or foreign file could. The library never writes one —
 * `encodeCanonical` checks the cap on write — so it is assembled here byte by
 * byte. A reader loses only that mask, named in `skipped`, never the
 * document; and raising the host's own cap does not let it in, because the
 * cap is the format's (the schema counts the box in cells), not the reader's.
 */

/** Unsigned LEB128 varints, base64'd: the canonical `counts` encoding. */
function rawCounts(runs: readonly number[]): string {
  const bytes: number[] = [];
  for (let n of runs) {
    while (n >= 0x80) {
      bytes.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    bytes.push(n);
  }
  return btoa(String.fromCharCode(...bytes));
}

// Two 10-cell dabs at opposite corners of a 13,000-square box: 169 M cells
// of box, 2.5x the cap, 20 painted.
const SIDE = 13_000;
const payload = {
  x: 0,
  y: 0,
  width: SIDE,
  height: SIDE,
  imageWidth: 20_000,
  imageHeight: 20_000,
  counts: rawCounts([0, 10, SIDE * SIDE - 20, 10]),
};

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

describe('a document holding a mask past the cap', () => {
  it('is a small payload, and well formed but for its size', () => {
    expect(SIDE * SIDE).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
    expect(payload.counts.length).toBeLessThan(32);
    // Only the cap stands between it and a valid mask.
    const raster = decodeCanonicalRaster(payload, { maxPixels: Number.POSITIVE_INFINITY });
    expect(raster.cellCount).toBe(20);
  });

  it('costs a default reader that mask, not the document', () => {
    const { byImage, skipped } = deserialize(doc);
    expect(Object.keys(byImage['img-1' as never]!)).toEqual(['rect']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe('big');
    expect(skipped[0]!.reason).toMatch(/pixel cap/);
  });

  it('is skipped even with maxMaskPixels: Infinity', () => {
    const { byImage, skipped } = deserialize(doc, {
      maxMaskPixels: Number.POSITIVE_INFINITY,
      maxTotalMaskPixels: Number.POSITIVE_INFINITY,
    });
    expect(Object.keys(byImage['img-1' as never]!)).toEqual(['rect']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe('big');
    expect(skipped[0]!.reason).toMatch(/pixel cap/);
  });
});
