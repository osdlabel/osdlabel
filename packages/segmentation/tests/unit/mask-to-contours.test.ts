import { describe, it, expect } from 'vitest';
import { maskToContours } from '../../src/mask-to-contours.js';
import type { SegmentationMask } from '../../src/mask.js';

/** Builds a mask with one or more filled axis-aligned rectangles. */
function rectMask(
  w: number,
  h: number,
  rects: ReadonlyArray<readonly [number, number, number, number]>,
  fill = 1,
): SegmentationMask {
  const data = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = fill;
  }
  return { width: w, height: h, data };
}

const bounds = (pts: { x: number; y: number }[]) => ({
  minX: Math.min(...pts.map((p) => p.x)),
  maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)),
  maxY: Math.max(...pts.map((p) => p.y)),
});

describe('maskToContours', () => {
  it('traces and simplifies a filled square to its four corners', () => {
    const mask = rectMask(12, 12, [[3, 3, 9, 9]]); // 6×6 block
    const rings = maskToContours(mask);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.length).toBeLessThanOrEqual(6); // simplified to ~4 corners
    const b = bounds(rings[0]!);
    expect(b.minX).toBe(3);
    expect(b.maxX).toBe(8);
    expect(b.minY).toBe(3);
    expect(b.maxY).toBe(8);
  });

  it('returns one ring per connected component, largest first', () => {
    const mask = rectMask(20, 10, [
      [1, 1, 7, 7], // big: 36 px
      [12, 2, 15, 5], // small: 9 px
    ]);
    const rings = maskToContours(mask);
    expect(rings).toHaveLength(2);
    // Largest-first: the first ring is the big component (its xs stay on the left).
    expect(bounds(rings[0]!).maxX).toBeLessThan(bounds(rings[1]!).minX);
  });

  it('drops components below minArea', () => {
    const mask = rectMask(20, 10, [
      [1, 1, 7, 7], // 36 px
      [12, 2, 15, 5], // 9 px
    ]);
    const rings = maskToContours(mask, { minArea: 20 });
    expect(rings).toHaveLength(1);
    expect(bounds(rings[0]!).maxX).toBeLessThan(10);
  });

  it('honors a probability threshold on float masks', () => {
    const w = 8;
    const h = 8;
    const data = new Float32Array(w * h).fill(0.1);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) data[y * w + x] = 0.9;
    const rings = maskToContours({ width: w, height: h, data }, { threshold: 0.5 });
    expect(rings).toHaveLength(1);
    expect(bounds(rings[0]!).minX).toBe(2);
  });

  it('keeps every boundary pixel when simplification is disabled', () => {
    const mask = rectMask(12, 12, [[3, 3, 9, 9]]);
    const simplified = maskToContours(mask, { simplifyTolerance: 1 });
    const raw = maskToContours(mask, { simplifyTolerance: 0 });
    // A 6×6 block has 6*4-4 = 20 perimeter pixels.
    expect(raw[0]!.length).toBe(20);
    expect(simplified[0]!.length).toBeLessThan(raw[0]!.length);
  });
});
