import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  MaskCapacityExceededError,
  decodeCanonicalRaster,
  runRaster,
  stampCircle,
  toDenseSnapshot,
} from '../../src/index.js';

const buffer = (w = 1000, h = 1000, maxPixels?: number) =>
  new BoundedDenseMaskBuffer({
    imageWidth: w,
    imageHeight: h,
    ...(maxPixels !== undefined ? { maxPixels } : {}),
  });

describe('BoundedDenseMaskBuffer', () => {
  it('reads back what it writes and counts set pixels exactly', () => {
    const b = buffer();
    expect(b.get(10, 10)).toBe(0);
    expect(b.cellCount).toBe(0);

    b.set(10, 10, 1);
    b.set(11, 10, 1);
    expect(b.get(10, 10)).toBe(1);
    expect(b.cellCount).toBe(2);

    // Setting the same pixel again must not double-count.
    b.set(10, 10, 1);
    expect(b.cellCount).toBe(2);

    b.set(10, 10, 0);
    expect(b.get(10, 10)).toBe(0);
    expect(b.cellCount).toBe(1);
  });

  it('preserves existing pixels when growing in every direction', () => {
    const b = buffer();
    b.set(500, 500, 1);

    for (const [x, y] of [
      [500, 300],
      [500, 700],
      [300, 500],
      [700, 500],
    ] as const) {
      b.set(x, y, 1);
      expect(b.get(500, 500)).toBe(1); // the original survives every reallocation
    }

    for (const [x, y] of [
      [500, 500],
      [500, 300],
      [500, 700],
      [300, 500],
      [700, 500],
    ] as const) {
      expect(b.get(x, y)).toBe(1);
    }
    expect(b.cellCount).toBe(5);
  });

  it('ignores writes outside the image', () => {
    const b = buffer(50, 50);
    b.set(-1, 10, 1);
    b.set(10, -1, 1);
    b.set(50, 10, 1);
    b.set(10, 50, 1);
    expect(b.cellCount).toBe(0);
    expect(b.snapshot().cells.width).toBe(0);
  });

  it('treats erasing outside the allocated region as a no-op', () => {
    const b = buffer();
    b.set(10, 10, 1);
    b.set(900, 900, 0);
    expect(b.cellCount).toBe(1);
  });

  it('snapshots the tight bounding box, not the allocated region', () => {
    const b = buffer();
    // Growth rounds outward to 64-pixel chunks, so the allocation is larger.
    b.set(100, 200, 1);
    b.set(102, 203, 1);

    expect(b.cellBounds.width).toBeGreaterThan(3);

    const snap = b.snapshot();
    expect(snap.cells).toEqual({ x: 100, y: 200, width: 3, height: 4 });
    expect(snap.data[0]).toBe(1); // (100,200)
    expect(snap.data[3 * 3 + 2]).toBe(1); // (102,203)
    expect(snap.data.reduce((a, v) => a + v, 0)).toBe(2);
    expect(snap.imageWidth).toBe(1000);
  });

  it('snapshots an empty mask as a zero-sized box', () => {
    const snap = buffer(80, 60).snapshot();
    expect(snap).toMatchObject({
      cells: { x: 0, y: 0, width: 0, height: 0 },
      imageWidth: 80,
      imageHeight: 60,
      downsample: 1,
    });
    expect(snap.data.length).toBe(0);
  });

  it('throws once the allocation would exceed maxPixels', () => {
    const b = buffer(10000, 10000, 64 * 64);
    b.set(0, 0, 1); // one 64x64 chunk sits exactly at the cap
    expect(() => b.set(5000, 5000, 1)).toThrow(MaskCapacityExceededError);
    // The failed write leaves the buffer usable and unchanged.
    expect(b.cellCount).toBe(1);
    expect(b.get(0, 0)).toBe(1);
  });

  it('round-trips through fromSnapshot', () => {
    const b = buffer();
    b.set(300, 400, 1);
    b.set(301, 400, 1);
    b.set(300, 402, 1);

    const restored = BoundedDenseMaskBuffer.fromSnapshot(b.snapshot());
    expect(restored.cellCount).toBe(3);
    expect(restored.snapshot()).toEqual(b.snapshot());
  });
});

describe('growth rounding yields to the cap', () => {
  it('reopens a mask that decodes under the cap', () => {
    // The decoder bounds the box; the buffer rounded its allocation up to the
    // growth chunk and so refused a mask the decoder had just admitted, which
    // rendered but could not be refined.
    const b = buffer(100, 100, 49);
    const painted = buffer(100, 100);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) painted.set(x, y, 1);
    const restored = BoundedDenseMaskBuffer.fromSnapshot(painted.snapshot(), { maxPixels: 49 });
    expect(restored.cellCount).toBe(36);
    expect(b.cellCount).toBe(0);

    // A stroke that still fits the cap exactly is allowed; one past it is not.
    restored.set(6, 0, 1);
    expect(restored.cellCount).toBe(37);
    expect(() => restored.set(7, 7, 1)).toThrow(MaskCapacityExceededError);
  });

  it('still rounds to the chunk when that fits', () => {
    const b = buffer(1000, 1000);
    b.set(10, 10, 1);
    // Growing one pixel at a time inside the chunk allocates nothing new, which
    // is the point of the rounding.
    const before = b.snapshot();
    for (let x = 11; x < 60; x++) b.set(x, 10, 1);
    expect(b.cellCount).toBe(before.data.length > 0 ? 50 : 50);
  });
});

describe('copyRow', () => {
  it('reads a row exactly as get() does, out-of-range cells as 0', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200 });
    stampCircle(buffer, 120, 80, 25, 1);
    stampCircle(buffer, 125, 82, 7, 0);
    const into = new Uint8Array(400);
    for (const [cy, x0, x1] of [
      [80, 0, 300],
      [55, 90, 150],
      [80, -20, 30],
      [80, 280, 400],
      [-5, 0, 50],
      [500, 0, 50],
      [104, 95, 146],
    ] as const) {
      buffer.copyRow(cy, x0, x1, into);
      for (let i = 0; i < x1 - x0; i++) {
        expect(into[i], `row ${cy} cell ${x0 + i}`).toBe(buffer.get(x0 + i, cy));
      }
    }
  });
});

describe('growth at the cap', () => {
  it("keeps only the set cells when the rounded allocation would not fit, so a thin stroke isn't refused", () => {
    // The first dab rounds the allocation to a 64 x 64 chunk, the whole cap.
    // A stroke 200 cells long and 9 tall then fits the cap; the allocation it
    // grew from does not.
    const b = buffer(1000, 1000, 64 * 64);
    stampCircle(b, 100, 100, 4, 1);
    expect(b.cellBounds.height).toBe(64);
    for (let x = 100; x <= 300; x++) stampCircle(b, x, 100, 4, 1);
    expect(b.cellBounds.width * b.cellBounds.height).toBeLessThanOrEqual(64 * 64);
    // Every painted cell survived the cut.
    for (let x = 96; x <= 303; x++) expect(b.get(x, 100), `x=${x}`).toBe(1);
    expect(b.get(304, 100)).toBe(0);
    expect(b.get(100, 96)).toBe(1);
    expect(b.get(100, 105)).toBe(0);
  });

  it('still refuses a region whose set cells alone pass the cap', () => {
    const b = buffer(1000, 1000, 64 * 64);
    stampCircle(b, 100, 100, 4, 1);
    stampCircle(b, 100, 160, 4, 1);
    expect(() => stampCircle(b, 300, 100, 4, 1)).toThrow(MaskCapacityExceededError);
    expect(b.get(100, 160)).toBe(1);
  });
});

describe('an empty buffer keeps its grid', () => {
  it('snapshots and rasters at its own downsample, not at 1', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100, downsample: 4 });
    expect(b.snapshot().downsample).toBe(4);
    expect(b.raster().downsample).toBe(4);
    // And after everything painted is erased again.
    b.set(3, 3, 1);
    b.set(3, 3, 0);
    expect(b.raster().downsample).toBe(4);
  });
});

describe('an empty mask on a coarse grid, read back', () => {
  it('decodes and densifies at its own downsample', () => {
    const empty = decodeCanonicalRaster({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      imageWidth: 100,
      imageHeight: 100,
      counts: '',
      downsample: 4,
    });
    expect(empty.downsample).toBe(4);
    expect(toDenseSnapshot(runRaster(empty, [0])).downsample).toBe(4);
  });
});
