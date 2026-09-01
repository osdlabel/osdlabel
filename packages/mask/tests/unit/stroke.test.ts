import { describe, it, expect } from 'vitest';
import { BoundedDenseMaskBuffer, stampCircle, strokeSegment } from '../../src/index.js';

const buffer = () => new BoundedDenseMaskBuffer({ imageWidth: 400, imageHeight: 400 });

describe('stampCircle', () => {
  it('fills exactly the pixels whose centres lie within the radius', () => {
    const b = buffer();
    // Centre on a pixel centre so the disc is symmetric about x=10, y=10.
    stampCircle(b, 10.5, 10.5, 3, 1);

    for (let x = 7; x <= 13; x++) expect(b.get(x, 10)).toBe(1);
    expect(b.get(6, 10)).toBe(0);
    expect(b.get(14, 10)).toBe(0);
    for (let y = 7; y <= 13; y++) expect(b.get(10, y)).toBe(1);

    // Corners of the bounding box are outside the disc.
    expect(b.get(13, 13)).toBe(0);
  });

  it('marks the pixel under the cursor even for a sub-pixel radius', () => {
    const b = buffer();
    stampCircle(b, 20.7, 30.2, 0.1, 1);
    expect(b.get(20, 30)).toBe(1);
    expect(b.pixelCount).toBe(1);
  });

  it('erases exactly the stamped disc, leaving surrounding pixels intact', () => {
    const b = buffer();
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) b.set(x, y, 1);
    const filled = b.pixelCount;

    stampCircle(b, 15.5, 15.5, 3, 0);

    expect(b.get(15, 15)).toBe(0);
    expect(b.get(13, 15)).toBe(0);
    expect(b.get(11, 15)).toBe(1); // just outside the disc
    expect(b.get(0, 0)).toBe(1);
    expect(b.pixelCount).toBeLessThan(filled);
  });

  it('ignores non-finite input', () => {
    const b = buffer();
    stampCircle(b, Number.NaN, 10, 3, 1);
    stampCircle(b, 10, 10, Number.POSITIVE_INFINITY, 1);
    expect(b.pixelCount).toBe(0);
  });
});

describe('strokeSegment', () => {
  it('leaves no gaps along a fast drag', () => {
    const b = buffer();
    // A single pointer-move jump of 90 px with a small brush: naive stamping
    // only at the endpoints would leave the middle unpainted.
    strokeSegment(b, 10, 100, 100, 100, 2, 1);
    for (let x = 10; x <= 100; x++) expect(b.get(x, 100)).toBe(1);
  });

  it('leaves no gaps on a diagonal drag', () => {
    const b = buffer();
    strokeSegment(b, 20, 20, 80, 60, 2, 1);
    // Every sampled point along the segment must be covered.
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      expect(b.get(Math.round(20 + 60 * t), Math.round(20 + 40 * t))).toBe(1);
    }
  });

  it('stamps once when the segment has zero length', () => {
    const b = buffer();
    strokeSegment(b, 50, 50, 50, 50, 0.1, 1);
    expect(b.pixelCount).toBe(1);
  });

  it('erases along the swept path', () => {
    const b = buffer();
    for (let y = 90; y < 110; y++) for (let x = 0; x < 120; x++) b.set(x, y, 1);
    strokeSegment(b, 10, 100, 100, 100, 2, 0);
    for (let x = 10; x <= 100; x++) expect(b.get(x, 100)).toBe(0);
    expect(b.get(0, 100)).toBe(1);
  });
});
