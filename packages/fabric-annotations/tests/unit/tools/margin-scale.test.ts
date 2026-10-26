import { describe, it, expect } from 'vitest';
import { marginScale } from '../../../src/tools/margin-scale.js';

describe('marginScale', () => {
  it('keeps the full margin when the grown box fits', () => {
    expect(marginScale(100, 50, 50, 25, 200 * 100)).toBe(1);
  });

  it('scales the margin so the grown box meets the area exactly', () => {
    for (const [w, h, mx, my, max] of [
      [4_000, 3_000, 2_000, 1_500, 16 * 1024 * 1024],
      [30_000, 10, 1_383, 5, 400_000],
      [10, 30_000, 0, 15_000, 400_000],
    ] as const) {
      const s = marginScale(w, h, mx, my, max);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
      expect((w + 2 * s * mx) * (h + 2 * s * my)).toBeCloseTo(max, 0);
    }
  });

  it('gives no margin to a box already at the area', () => {
    expect(marginScale(100, 100, 50, 50, 100 * 100)).toBe(0);
    expect(marginScale(100, 100, 50, 50, 50)).toBe(0);
  });
});
