import { describe, it, expect } from 'vitest';
import {
  denseRaster,
  majorityCoarsen,
  toDenseSnapshot,
  verifyCoarsenStrategy,
  type CoarsenStrategy,
  type MaskRaster,
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

  it('catches a strategy that pairs children from the box origin, not the grid (#243 minor 2)', () => {
    // Majority over the cells shifted to an even origin: at an even origin the
    // same as the built-in rule; at an odd one, each pair straddles two coarse
    // cells, and the mask moves by one fine cell.
    const boxRelative: CoarsenStrategy = (source) => {
      const snapshot = toDenseSnapshot(source);
      const { x, y } = snapshot.cells;
      return majorityCoarsen(
        denseRaster({ ...snapshot, cells: { ...snapshot.cells, x: x - (x & 1), y: y - (y & 1) } }),
      );
    };
    const found = rules(verifyCoarsenStrategy(boxRelative));
    expect(found).toContain('deterministic');
    expect(found).toContain('undoes re-gridding');
  });

  it('reports a strategy that returns no raster, rather than passing or throwing (#243 minor 3)', () => {
    for (const value of [undefined, null, {}, 3]) {
      const broken = (() => value) as unknown as CoarsenStrategy;
      const violations = verifyCoarsenStrategy(broken);
      expect(rules(violations), String(value)).toEqual(new Set(['valid']));
      expect(violations[0]).toMatch(/not a raster/);
    }
  });

  it("does not trust a result's cellCount or get (#243 minor 4)", () => {
    // Erodes like `unanimous` above would, then reports the built-in rule's
    // count and answers `get` as the built-in result does.
    const liar: CoarsenStrategy = (source) => {
      const honest = majorityCoarsen(source);
      const eroded = toDenseSnapshot(honest);
      const data = eroded.data.slice();
      const last = data.lastIndexOf(1);
      if (last >= 0) data[last] = 0;
      const spans = denseRaster({ ...eroded, data });
      const result: MaskRaster = {
        cells: honest.cells,
        imageWidth: honest.imageWidth,
        imageHeight: honest.imageHeight,
        downsample: honest.downsample,
        cellCount: honest.cellCount,
        get: (cx, cy) => honest.get(cx, cy),
        forEachSpan: (visit, within) => spans.forEachSpan(visit, within),
      };
      return result;
    };
    expect(rules(verifyCoarsenStrategy(liar))).toContain('undoes re-gridding');
  });

  it('reports a result with a span walk but no usable box, rather than throwing (#243 round 2, minor 4)', () => {
    for (const [name, value] of [
      [
        'no cells',
        { forEachSpan: () => {}, get: () => 0, downsample: 2, imageWidth: 1, imageHeight: 1 },
      ],
      [
        'cells: null',
        {
          forEachSpan: () => {},
          get: () => 0,
          cells: null,
          downsample: 2,
          imageWidth: 1,
          imageHeight: 1,
        },
      ],
    ] as const) {
      const strategy = (() => value) as unknown as CoarsenStrategy;
      let violations: readonly string[] = [];
      expect(() => (violations = verifyCoarsenStrategy(strategy)), name).not.toThrow();
      expect(rules(violations), name).toEqual(new Set(['valid']));
      expect(violations[0], name).toMatch(/not a raster/);
    }
  });

  it('reports a strategy that throws what resists formatting (#243 round 2, minor 3)', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const strategy: CoarsenStrategy = () => {
      throw revoked.proxy;
    };
    let violations: readonly string[] = [];
    expect(() => (violations = verifyCoarsenStrategy(strategy))).not.toThrow();
    expect(violations[0]).toMatch(/threw a value with no string form/);
  });
});
