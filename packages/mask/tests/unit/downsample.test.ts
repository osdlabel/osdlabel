import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MAX_MASK_DOWNSAMPLE,
  MaskCapacityExceededError,
  cocoArea,
  cocoBbox,
  cocoCountsToSnapshot,
  cocoRleCodec,
  decodeCanonical,
  encodeCanonical,
  isMaskDownsample,
  maskGridSize,
  snapshotCellCount,
  snapshotImageBox,
  snapshotPixelCount,
  snapshotToCocoCounts,
  stampCircle,
  strokeSegment,
  upsampleSnapshot,
  denseRaster,
  toDenseSnapshot,
  type CanonicalMaskData,
  type MaskSnapshot,
} from '../../src/index.js';

/** A hand-built snapshot: `rows` of '#'/'.' over cells, placed at cell (x, y). */
function cells(
  rows: readonly string[],
  options: { x: number; y: number; downsample: number; imageWidth: number; imageHeight: number },
): MaskSnapshot {
  const width = rows[0]!.length;
  const data = new Uint8Array(width * rows.length);
  rows.forEach((row, r) => {
    for (let c = 0; c < width; c++) if (row[c] === '#') data[r * width + c] = 1;
  });
  return {
    cells: { x: options.x, y: options.y, width, height: rows.length },
    data,
    imageWidth: options.imageWidth,
    imageHeight: options.imageHeight,
    downsample: options.downsample,
  };
}

/**
 * 4x downsampled, on a 37x23 image — neither side a multiple of 4, so the
 * last cell column (x = 9 covers image columns 36..36) and last cell row
 * (y = 5 covers image rows 20..22) are clipped by the image edge, and the
 * mask touches both.
 */
const EDGE = cells(['.##.', '#..#', '####'], {
  x: 6,
  y: 3,
  downsample: 4,
  imageWidth: 37,
  imageHeight: 23,
});

describe('isMaskDownsample', () => {
  it('accepts powers of two from 1 to the maximum, and nothing else', () => {
    for (const d of [1, 2, 4, 8, 1024, MAX_MASK_DOWNSAMPLE]) expect(isMaskDownsample(d)).toBe(true);
    for (const d of [0, -2, 3, 6, 2.5, Number.NaN, MAX_MASK_DOWNSAMPLE * 2, '2', null]) {
      expect(isMaskDownsample(d)).toBe(false);
    }
  });
});

describe('downsampled buffer', () => {
  it('rasterizes an image-space disc on its cell grid', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 400, imageHeight: 300, downsample: 8 });
    expect(buffer.gridWidth).toBe(50);
    expect(buffer.gridHeight).toBe(38); // ceil(300 / 8)
    // Radius 20 image px = 2.5 cells, centred on cell (12, 10)'s centre.
    stampCircle(buffer, 12.5 * 8, 10.5 * 8, 20, 1);
    const snapshot = buffer.snapshot();
    expect(snapshot.downsample).toBe(8);
    // Cell centres within 2.5 cells: a 5x5 disc minus its corners (21 cells).
    expect(snapshotCellCount(snapshot)).toBe(21);
    expect(snapshot.cells).toEqual({ x: 10, y: 8, width: 5, height: 5 });
    expect(snapshotPixelCount(snapshot)).toBe(21 * 64);
    expect(snapshotImageBox(snapshot)).toEqual({ x: 80, y: 64, width: 40, height: 40 });
  });

  it('marks the cell under a brush finer than one cell', () => {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 400,
      imageHeight: 300,
      downsample: 16,
    });
    stampCircle(buffer, 100, 50, 2, 1);
    const snapshot = buffer.snapshot();
    expect(snapshot.cells).toEqual({ x: 6, y: 3, width: 1, height: 1 });
  });

  it('applies the cap to cells, so a coarser grid reaches further', () => {
    const cap = 64 * 64;
    const fine = new BoundedDenseMaskBuffer({
      imageWidth: 4096,
      imageHeight: 4096,
      maxPixels: cap,
    });
    expect(() => strokeSegment(fine, 10, 10, 4000, 4000, 8, 1)).toThrow(MaskCapacityExceededError);
    const coarse = new BoundedDenseMaskBuffer({
      imageWidth: 4096,
      imageHeight: 4096,
      maxPixels: cap,
      downsample: 64,
    });
    strokeSegment(coarse, 10, 10, 4000, 4000, 8, 1);
    const box = snapshotImageBox(coarse.snapshot());
    expect(box.x).toBe(0);
    expect(box.x + box.width).toBe(4032);
  });

  it('rejects a downsample that is not a power of two', () => {
    expect(
      () => new BoundedDenseMaskBuffer({ imageWidth: 10, imageHeight: 10, downsample: 3 }),
    ).toThrow(RangeError);
  });

  it('round-trips through fromSnapshot at its own downsample', () => {
    const buffer = BoundedDenseMaskBuffer.fromSnapshot(EDGE);
    expect(buffer.downsample).toBe(4);
    expect(buffer.snapshot()).toEqual(EDGE);
  });
});

describe('snapshotPixelCount at a downsample', () => {
  it('counts image pixels, clipping the cells the image edge cuts', () => {
    const expanded = upsampleSnapshot(EDGE, Infinity);
    expect(snapshotPixelCount(EDGE)).toBe(snapshotCellCount(expanded));
    // Interior cells are 16 px; the edge column is 1 px wide, the edge row 3.
    // Row y=3: cells x=7,8 -> 32. Row y=4: x=6 (16) and x=9 (1x4 = 4) -> 20.
    // Row y=5 (3 rows high): x=6,7,8 (4x3 each = 36) and x=9 (1x3 = 3) -> 39.
    expect(snapshotPixelCount(EDGE)).toBe(32 + 20 + 39);
  });
});

describe('canonical codec at a downsample', () => {
  it('writes the box in image pixels and round-trips the cells exactly', () => {
    const payload = encodeCanonical(EDGE);
    expect(payload).toMatchObject({
      x: 24,
      y: 12,
      width: 13, // 24..36, clipped by the 37-px image
      height: 11, // 12..22, clipped by the 23-px image
      imageWidth: 37,
      imageHeight: 23,
      downsample: 4,
    });
    expect(decodeCanonical(payload)).toEqual(EDGE);
  });

  it('writes a full-resolution payload exactly as before, with no field', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 50, imageHeight: 50 });
    stampCircle(buffer, 20, 20, 5, 1);
    const payload = encodeCanonical(buffer.snapshot());
    expect('downsample' in payload).toBe(false);
    expect(Object.keys(payload)).toEqual([
      'x',
      'y',
      'width',
      'height',
      'imageWidth',
      'imageHeight',
      'counts',
    ]);
  });

  it('caps the decode by cells, not by the image-pixel box', () => {
    const big = {
      x: 0,
      y: 0,
      width: 16_384,
      height: 16_384,
      imageWidth: 20_000,
      imageHeight: 20_000,
      // One run of background over 2^26 cells, LEB128 + base64.
      counts: 'gICAIA==', // the bytes 80 80 80 20
    } satisfies CanonicalMaskData;
    expect(() => decodeCanonical(big)).toThrow(MaskCapacityExceededError);
    const snapshot = decodeCanonical({ ...big, downsample: 2 });
    expect(snapshot.cells.width * snapshot.cells.height).toBe(DEFAULT_MAX_MASK_PIXELS);
  });

  it('fails closed for a reader that drops the field', () => {
    const { downsample: _dropped, ...stripped } = encodeCanonical(EDGE);
    expect(() => decodeCanonical(stripped)).toThrow(/Run lengths sum to 12, but the box holds 143/);
  });

  it('fails closed at every downsample, not only the one above', () => {
    // A reader that predates the field reads the box as a level-0 grid. The
    // runs then sum to the coarser grid's cells, never to the box's pixels,
    // so the payload is refused rather than drawn shrunk towards the origin.
    for (let d = 2; d <= 256; d *= 2) {
      const buffer = new BoundedDenseMaskBuffer({
        imageWidth: 5000,
        imageHeight: 5000,
        downsample: d,
      });
      stampCircle(buffer, 2500, 2500, Math.max(600, 2 * d), 1);
      const payload = encodeCanonical(buffer.snapshot());
      expect(payload.downsample).toBe(d);
      const { downsample: _dropped, ...stripped } = payload;
      expect(() => decodeCanonical(stripped), `d=${d}`).toThrow(/Run lengths sum to/);
    }
  });

  it('refuses a box that is not aligned to its cells', () => {
    const payload = encodeCanonical(EDGE);
    expect(() => decodeCanonical({ ...payload, x: payload.x + 1, width: 12 })).toThrow(
      /not aligned/,
    );
    // Right edge short of both a cell boundary and the image edge.
    expect(() => decodeCanonical({ ...payload, width: 11 })).toThrow(/not aligned/);
  });

  it('refuses an unusable downsample', () => {
    const payload = encodeCanonical(EDGE);
    for (const downsample of [0, 3, 0.5, MAX_MASK_DOWNSAMPLE * 2]) {
      expect(() => decodeCanonical({ ...payload, downsample })).toThrow(/power of two/);
    }
  });
});

describe('COCO RLE at a downsample', () => {
  it('exports exactly the level-0 mask the cells mean', () => {
    const expanded = upsampleSnapshot(EDGE, Infinity);
    expect(snapshotToCocoCounts(EDGE)).toEqual(snapshotToCocoCounts(expanded));
    expect(cocoBbox(EDGE)).toEqual(cocoBbox(expanded));
    expect(cocoArea(EDGE)).toBe(cocoArea(expanded));
  });

  it('decodes back to the upsampled mask', () => {
    const encoded = cocoRleCodec.encode(denseRaster(EDGE));
    expect(toDenseSnapshot(cocoRleCodec.decode!(encoded))).toEqual(
      upsampleSnapshot(EDGE, Infinity),
    );
  });

  it('matches the upsampled export for a painted mask on a large image', () => {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 601,
      imageHeight: 403,
      downsample: 16,
    });
    strokeSegment(buffer, 20, 60, 598, 398, 40, 1);
    stampCircle(buffer, 300, 230, 30, 0);
    const snapshot = buffer.snapshot();
    const expanded = upsampleSnapshot(snapshot, Infinity);
    const counts = snapshotToCocoCounts(snapshot);
    expect(counts).toEqual(snapshotToCocoCounts(expanded));
    const decoded = cocoCountsToSnapshot(counts, 403, 601, { maxPixels: Infinity });
    // Compared as plain arrays: a deep equality over a typed array is slow.
    expect({ ...decoded, data: Array.from(decoded.data) }).toEqual({
      ...expanded,
      data: Array.from(expanded.data),
    });
    // The stroke reaches the image's clipped last column and row.
    const box = snapshotImageBox(snapshot);
    expect(box.x + box.width).toBe(601);
    expect(box.y + box.height).toBe(403);
  });
});

describe('maskGridSize', () => {
  it('rounds up, as a Deep Zoom pyramid does', () => {
    expect(maskGridSize(56_000, 40_600, 8)).toEqual({ width: 7000, height: 5075 });
    expect(maskGridSize(37, 23, 4)).toEqual({ width: 10, height: 6 });
  });
});
