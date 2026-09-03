import { describe, it, expect } from 'vitest';
import { BoundedDenseMaskBuffer, MaskCapacityExceededError } from '../../src/index.js';

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
    expect(b.pixelCount).toBe(0);

    b.set(10, 10, 1);
    b.set(11, 10, 1);
    expect(b.get(10, 10)).toBe(1);
    expect(b.pixelCount).toBe(2);

    // Setting the same pixel again must not double-count.
    b.set(10, 10, 1);
    expect(b.pixelCount).toBe(2);

    b.set(10, 10, 0);
    expect(b.get(10, 10)).toBe(0);
    expect(b.pixelCount).toBe(1);
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
    expect(b.pixelCount).toBe(5);
  });

  it('ignores writes outside the image', () => {
    const b = buffer(50, 50);
    b.set(-1, 10, 1);
    b.set(10, -1, 1);
    b.set(50, 10, 1);
    b.set(10, 50, 1);
    expect(b.pixelCount).toBe(0);
    expect(b.snapshot().width).toBe(0);
  });

  it('treats erasing outside the allocated region as a no-op', () => {
    const b = buffer();
    b.set(10, 10, 1);
    b.set(900, 900, 0);
    expect(b.pixelCount).toBe(1);
  });

  it('snapshots the tight bounding box, not the allocated region', () => {
    const b = buffer();
    // Growth rounds outward to 64-pixel chunks, so the allocation is larger.
    b.set(100, 200, 1);
    b.set(102, 203, 1);

    expect(b.bounds.width).toBeGreaterThan(3);

    const snap = b.snapshot();
    expect(snap.x).toBe(100);
    expect(snap.y).toBe(200);
    expect(snap.width).toBe(3);
    expect(snap.height).toBe(4);
    expect(snap.data[0]).toBe(1); // (100,200)
    expect(snap.data[3 * 3 + 2]).toBe(1); // (102,203)
    expect(snap.data.reduce((a, v) => a + v, 0)).toBe(2);
    expect(snap.imageWidth).toBe(1000);
  });

  it('snapshots an empty mask as a zero-sized box', () => {
    const snap = buffer(80, 60).snapshot();
    expect(snap).toMatchObject({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      imageWidth: 80,
      imageHeight: 60,
    });
    expect(snap.data.length).toBe(0);
  });

  it('throws once the allocation would exceed maxPixels', () => {
    const b = buffer(10000, 10000, 64 * 64);
    b.set(0, 0, 1); // one 64x64 chunk sits exactly at the cap
    expect(() => b.set(5000, 5000, 1)).toThrow(MaskCapacityExceededError);
    // The failed write leaves the buffer usable and unchanged.
    expect(b.pixelCount).toBe(1);
    expect(b.get(0, 0)).toBe(1);
  });

  it('round-trips through fromSnapshot', () => {
    const b = buffer();
    b.set(300, 400, 1);
    b.set(301, 400, 1);
    b.set(300, 402, 1);

    const restored = BoundedDenseMaskBuffer.fromSnapshot(b.snapshot());
    expect(restored.pixelCount).toBe(3);
    expect(restored.snapshot()).toEqual(b.snapshot());
  });
});
