import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  decodeCanonical,
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
    expect(original).toMatchObject({ x: 7, y: 9, width: 1, height: 1 });
    expect(decodeCanonical(encodeCanonical(original))).toEqual(original);
  });

  it('preserves the bounding box placement and image size', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 640, imageHeight: 480 });
    b.set(300, 200, 1);
    const encoded = encodeCanonical(b.snapshot());
    expect(encoded).toMatchObject({ x: 300, y: 200, imageWidth: 640, imageHeight: 480 });
  });
});
