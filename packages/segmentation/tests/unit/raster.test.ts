import { describe, expect, it } from 'vitest';
import { MaskCapacityExceededError, snapshotPixelCount, encodeCanonical, decodeCanonical } from '@osdlabel/mask';
import { binaryIou, fillRings } from '@osdlabel/mask-contour';
import {
  modelFrame,
  modelGridFrame,
  imageToModel,
  modelToImage,
  rankCandidates,
  rasterToMaskSnapshot,
  rasterToPolygons,
  stabilityScore,
  type RasterMask,
} from '../../src/index.js';

/** A 256x256 logit disc placed so one raster px = `cell` image px. */
function discRaster(cell: number, originX: number, originY: number, radiusPx = 60): RasterMask {
  const n = 256;
  const data = new Float32Array(n * n);
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) data[v * n + u] = (radiusPx - Math.hypot(u + 0.5 - 128, v + 0.5 - 128)) / 4;
  }
  return {
    frame: { originX, originY, pixelWidth: cell, pixelHeight: cell, width: n, height: n },
    data,
  };
}

describe('model frames', () => {
  it('letterboxes a wide region and round-trips points', () => {
    const view = { imageKey: 'a', imageSize: { width: 50_000, height: 50_000 }, region: { x: 1000, y: 2000, width: 16_000, height: 9_000 }, scale: 1024 / 16_000 };
    const f = modelFrame(view, 1024, 'letterbox');
    expect(f.contentWidth).toBe(1024);
    expect(f.contentHeight).toBe(576);
    const p = { x: 9000, y: 6500 };
    const back = modelToImage(f, imageToModel(f, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
    const grid = modelGridFrame(f, 256);
    expect(grid.width).toBe(256);
    expect(grid.height).toBe(144);
    expect(grid.pixelWidth).toBeCloseTo(62.5, 6);
  });

  it('stretches for SAM 2-style inputs', () => {
    const view = { imageKey: 'a', imageSize: { width: 5000, height: 5000 }, region: { x: 0, y: 0, width: 2000, height: 1000 }, scale: 1024 / 2000 };
    const f = modelFrame(view, 1024, 'stretch');
    expect(f.scaleX).toBeCloseTo(0.512);
    expect(f.scaleY).toBeCloseTo(1.024);
  });
});

describe('rasterToMaskSnapshot', () => {
  it('upsamples logits to image pixels and agrees with the disc area', () => {
    const r = discRaster(4, 1000, 1000);
    const snap = rasterToMaskSnapshot(r, { width: 10_000, height: 10_000 });
    const expected = Math.PI * (60 * 4) ** 2;
    expect(Math.abs(snapshotPixelCount(snap) - expected) / expected).toBeLessThan(0.01);
    // A valid #149 mask: the canonical codec round-trips it.
    const back = decodeCanonical(encodeCanonical(snap));
    expect(back.width).toBe(snap.width);
  });

  it('throws MaskCapacityExceededError when a coarse encode covers too many image pixels', () => {
    // One raster px = 64 image px: the disc spans ~7700 px -> ~59 Mpx box.
    const r = discRaster(64, 0, 0);
    expect(() => rasterToMaskSnapshot(r, { width: 100_000, height: 80_000 }, { maxPixels: 16 << 20 })).toThrow(
      MaskCapacityExceededError,
    );
  });

  it('handles binary rasters with nearest sampling', () => {
    const data = new Uint8Array(16).fill(0);
    data[5] = 1;
    const snap = rasterToMaskSnapshot(
      { frame: { originX: 10, originY: 20, pixelWidth: 3, pixelHeight: 3, width: 4, height: 4 }, data },
      { width: 100, height: 100 },
    );
    expect(snap).toMatchObject({ x: 13, y: 23, width: 3, height: 3 });
    expect(snapshotPixelCount(snap)).toBe(9);
  });
});

describe('rasterToPolygons', () => {
  it('vectorises at raster resolution and matches the upsampled mask', () => {
    const r = discRaster(4, 1000, 1000);
    const polys = rasterToPolygons(r, { tolerance: 1 });
    expect(polys).toHaveLength(1);
    const snap = rasterToMaskSnapshot(r, { width: 10_000, height: 10_000 });
    const filled = fillRings([polys[0]!.outer], snap.width, snap.height, snap.x, snap.y);
    expect(binaryIou(filled, snap.data)).toBeGreaterThan(0.99);
    expect(polys[0]!.outer.length).toBeLessThan(200);
  });
});

describe('candidate ranking', () => {
  it('computes stability and ranks by it', () => {
    const sharp = discRaster(1, 0, 0);
    const soft: RasterMask = { ...sharp, data: sharp.data.map((v) => v / 50) };
    expect(stabilityScore(sharp)).toBeGreaterThan(stabilityScore(soft));
    const ranked = rankCandidates(
      [
        { mask: soft, predictedIou: 0.95 },
        { mask: sharp, predictedIou: 0.9 },
      ],
      'stability',
    );
    expect(ranked[0]!.mask).toBe(sharp);
  });
});
