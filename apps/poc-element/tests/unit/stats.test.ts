import { describe, expect, it } from 'vitest';
import {
  compressedSizes,
  diffStyleSignatures,
  quantile,
  summarize,
  table,
} from '../../scripts/lib/stats.mjs';

describe('quantile / summarize', () => {
  it('interpolates linearly between order statistics', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([10], 0.75)).toBe(10);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it('summarizes a sample', () => {
    const s = summarize([5, 1, 3]);
    expect(s).toMatchObject({ n: 3, median: 3, min: 1, max: 5, mean: 3 });
  });
});

describe('compressedSizes', () => {
  it('compresses repetitive input below its raw size', () => {
    const buf = new TextEncoder().encode('osdlabel '.repeat(1000));
    const s = compressedSizes(buf);
    expect(s.raw).toBe(9000);
    expect(s.gzip).toBeLessThan(200);
    expect(s.brotli).toBeLessThan(s.gzip);
  });
});

describe('diffStyleSignatures', () => {
  it('counts differing elements and properties, and missing paths', () => {
    const base = [
      { path: '0', props: { color: 'red', 'font-size': '12px' } },
      { path: '0/1', props: { color: 'blue', 'font-size': '12px' } },
      { path: '0/2', props: { color: 'blue', 'font-size': '12px' } },
    ];
    const other = [
      { path: '0', props: { color: 'red', 'font-size': '12px' } },
      { path: '0/1', props: { color: 'green', 'font-size': '16px' } },
    ];
    expect(diffStyleSignatures(base, other)).toEqual({
      compared: 3,
      elementsDiffering: 1,
      missing: 1,
      propertyCounts: { color: 1, 'font-size': 1 },
    });
  });
});

describe('table', () => {
  it('pads columns to the widest cell', () => {
    expect(table(['a', 'bb'], [['xxx', 1]])).toBe('a    bb\n---  --\nxxx  1 ');
  });
});
