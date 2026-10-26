import { describe, it, expect } from 'vitest';
import {
  denseRaster,
  majorityCoarsen,
  toDenseSnapshot,
  verifyCoarsenStrategy,
  type CoarsenStrategy,
} from '../../src/index.js';

const rules = (violations: readonly string[]) => new Set(violations.map((v) => v.split(':')[0]));

describe('verifyCoarsenStrategy', () => {
  it('finds nothing wrong with the built-in rule', () => {
    expect(verifyCoarsenStrategy(majorityCoarsen)).toEqual([]);
  });

  it('catches a strategy that is not deterministic', () => {
    // Majority, with each tie decided by a coin.
    const coin: CoarsenStrategy = (source) => {
      const result = toDenseSnapshot(majorityCoarsen(source));
      const data = result.data.slice();
      for (let i = 0; i < data.length; i++) if (Math.random() < 0.3) data[i] = data[i] ? 0 : 1;
      return denseRaster({ ...result, data });
    };
    expect(rules(verifyCoarsenStrategy(coin))).toContain('deterministic');
  });

  it('catches a strategy whose result is not a valid coarsening', () => {
    const unchanged: CoarsenStrategy = (source) => source;
    expect(rules(verifyCoarsenStrategy(unchanged))).toContain('valid');

    // The right downsample, but a cell set past the source's box.
    const spill: CoarsenStrategy = (source) => {
      const result = toDenseSnapshot(majorityCoarsen(source));
      const { x, y, width, height } = result.cells;
      if (width === 0 || height === 0 || x === 0) return denseRaster(result);
      const data = new Uint8Array((width + 1) * height);
      for (let r = 0; r < height; r++) {
        data.set(result.data.subarray(r * width, (r + 1) * width), r * (width + 1) + 1);
      }
      data[0] = 1;
      return denseRaster({ ...result, cells: { x: x - 1, y, width: width + 1, height }, data });
    };
    expect(rules(verifyCoarsenStrategy(spill))).toContain('valid');
  });

  it('catches a strategy that erodes a re-gridded mask', () => {
    // Deterministic and valid, but every coarse cell needs all four children:
    // a replicated block survives, its clipped edge cells do not.
    const unanimous: CoarsenStrategy = (source) => {
      const coarse = toDenseSnapshot(majorityCoarsen(source));
      const data = coarse.data.slice();
      const { x, y, width } = coarse.cells;
      for (let i = 0; i < data.length; i++) {
        if (!data[i]) continue;
        const cx = x + (i % width);
        const cy = y + Math.floor(i / width);
        let all = true;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          if (source.get(cx * 2 + dx, cy * 2 + dy) !== 1) all = false;
        }
        if (!all) data[i] = 0;
      }
      return denseRaster({ ...coarse, data });
    };
    const found = rules(verifyCoarsenStrategy(unanimous));
    expect(found).toContain('undoes re-gridding');
    expect(found).not.toContain('deterministic');
    expect(found).not.toContain('valid');
  });
});
