import { describe, expect, it } from 'vitest';
import { buildPyramid, downsample2x, extractRegion } from '../../src/pyramid.js';

describe('downsample2x', () => {
  it('box-averages without losing 16-bit precision', () => {
    const r = downsample2x({
      width: 2,
      height: 2,
      data: new Uint16Array([60000, 60002, 60004, 60006]),
    });
    expect(r.width).toBe(1);
    expect(r.data[0]).toBe(60003);
    expect(r.data).toBeInstanceOf(Uint16Array);
  });

  it('keeps signed values and handles odd edges', () => {
    const r = downsample2x({ width: 3, height: 1, data: new Int16Array([-1000, -998, 500]) });
    expect(r.width).toBe(2);
    expect(r.height).toBe(1);
    expect(r.data[0]).toBe(-999);
    expect(r.data[1]).toBe(500);
  });
});

describe('buildPyramid', () => {
  it('runs from 1x1 up to full resolution', () => {
    const levels = buildPyramid({ width: 8, height: 4, data: new Int16Array(32) });
    expect(levels.map((l) => [l.width, l.height])).toEqual([
      [1, 1],
      [2, 1],
      [4, 2],
      [8, 4],
    ]);
  });
});

describe('extractRegion', () => {
  it('copies and clips', () => {
    const data = new Int16Array(16).map((_, i) => i);
    const r = extractRegion({ width: 4, height: 4, data }, 2, 2, 4, 4);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect([...r.data]).toEqual([10, 11, 14, 15]);
  });
});
