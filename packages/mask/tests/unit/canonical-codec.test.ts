import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  decodeCanonical,
  decodeCanonicalRaster,
  runRaster,
  encodeCanonical,
  fromRuns,
  toRuns,
  stampCircle,
} from '../../src/index.js';

describe('run-length helpers', () => {
  it('extracts alternating runs starting with background', () => {
    expect(toRuns(Uint8Array.from([0, 0, 1, 1, 1, 0, 1]))).toEqual([2, 3, 1, 1]);
    // A mask starting with foreground still begins with a zero-length run.
    expect(toRuns(Uint8Array.from([1, 1, 0]))).toEqual([0, 2, 1]);
  });

  it('round-trips runs back to pixels', () => {
    const pixels = Uint8Array.from([0, 1, 1, 0, 0, 1]);
    expect(fromRuns(toRuns(pixels), pixels.length)).toEqual(pixels);
  });
});

describe('canonical codec', () => {
  it('round-trips a painted mask exactly', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 500, imageHeight: 400 });
    stampCircle(b, 120.5, 90.5, 12, 1);
    stampCircle(b, 130.5, 95.5, 5, 0); // punch a hole so the runs are non-trivial

    const original = b.snapshot();
    const restored = decodeCanonical(encodeCanonical(original));
    expect(restored).toEqual(original);
  });

  it('round-trips an empty mask', () => {
    const original = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 30 }).snapshot();
    const encoded = encodeCanonical(original);
    expect(encoded.counts).toBe('');
    expect(decodeCanonical(encoded)).toEqual(original);
  });

  it('round-trips a single-pixel mask', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 30 });
    b.set(7, 9, 1);
    const original = b.snapshot();
    expect(original.cells).toEqual({ x: 7, y: 9, width: 1, height: 1 });
    expect(decodeCanonical(encodeCanonical(original))).toEqual(original);
  });

  it('preserves the bounding box placement and image size', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 640, imageHeight: 480 });
    b.set(300, 200, 1);
    const encoded = encodeCanonical(b.snapshot());
    expect(encoded).toMatchObject({ x: 300, y: 200, imageWidth: 640, imageHeight: 480 });
  });
});

describe('the cap on write', () => {
  // Built from runs, so neither box is allocated.
  const oneCellAt = (side: number, image: number, downsample: number) =>
    runRaster(
      {
        cells: { x: 0, y: 0, width: side, height: side },
        imageWidth: image,
        imageHeight: image,
        downsample,
      },
      [0, 1, side * side - 1],
    );

  it('refuses a box past the cap, as every reader would refuse the payload', () => {
    const over = oneCellAt(8193, 8193, 1);
    expect(8193 * 8193).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
    expect(() => encodeCanonical(over)).toThrow(MaskCapacityExceededError);
  });

  it('counts the box in cells: a 16384-square box at downsample 2 is at the cap, not past it', () => {
    const atCap = oneCellAt(8192, 16_384, 2);
    expect(8192 * 8192).toBe(DEFAULT_MAX_MASK_PIXELS);
    const payload = encodeCanonical(atCap);
    expect(payload).toMatchObject({ width: 16_384, height: 16_384, downsample: 2 });
    expect(decodeCanonicalRaster(payload).cellCount).toBe(1);
  });
});
