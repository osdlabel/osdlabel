import { describe, it, expect } from 'vitest';
import { growPreviewBounds, marginScale } from '../../../src/tools/margin-scale.js';
import { MAX_MASK_CANVAS_PIXELS } from '../../../src/mask-canvas-limit.js';

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

describe('growPreviewBounds', () => {
  it('spends no margin on room the image edge clips away (#243 round 2, minor 6)', () => {
    // A full-height 7,000 x 2,000 box at the left edge of a 20,000 x 2,000
    // grid: 14 M cells, under 16 Mi. Only the right side has room. Charging
    // the clipped top, bottom and left margins against the budget left the
    // right one 331 cells, so the preview was rebuilt about once per 64-cell
    // chunk near the budget: 18 previews, 310 Mi px, on a full-height bar.
    const box = { x: 0, y: 0, width: 7_000, height: 2_000 };
    const grown = growPreviewBounds(box, 20_000, 2_000);
    expect([grown.x, grown.y, grown.height]).toEqual([0, 0, 2_000]);
    // The budget's whole remainder goes right: 16 Mi / 2,000 - 7,000 = 1,388.
    expect(grown.width - box.width).toBe(1_388);
    expect(grown.width * grown.height).toBeLessThanOrEqual(MAX_MASK_CANVAS_PIXELS);
  });

  it('always contains the box, and stays in the grid', () => {
    for (const [box, w, h] of [
      [{ x: 0, y: 0, width: 10, height: 10 }, 10, 10],
      [{ x: 5, y: 5, width: 4_000, height: 4_000 }, 5_000, 5_000],
      [{ x: 30_000, y: 0, width: 32_767, height: 1 }, 100_000, 3],
    ] as const) {
      const grown = growPreviewBounds(box, w, h);
      expect(grown.x).toBeLessThanOrEqual(box.x);
      expect(grown.y).toBeLessThanOrEqual(box.y);
      expect(grown.x + grown.width).toBeGreaterThanOrEqual(box.x + box.width);
      expect(grown.y + grown.height).toBeGreaterThanOrEqual(box.y + box.height);
      expect(grown.x).toBeGreaterThanOrEqual(0);
      expect(grown.y + grown.height).toBeLessThanOrEqual(Math.max(h, box.y + box.height));
    }
  });
});
