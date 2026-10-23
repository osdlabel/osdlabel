import { describe, expect, it } from 'vitest';
import {
  chooseLevel,
  describeOsdTileSource,
  dziLevelSize,
  dziMaxLevel,
  planRegionRead,
  type DziPyramid,
} from '../../src/index.js';

const P: DziPyramid = {
  kind: 'dzi',
  width: 100_000,
  height: 80_000,
  tileSize: 254,
  overlap: 1,
  tileUrlTemplate: '/synth/gigapixel_files/{level}/{x}_{y}.jpeg',
};

describe('DZI geometry', () => {
  it('matches the Deep Zoom level formula', () => {
    expect(dziMaxLevel(P.width, P.height)).toBe(17);
    expect(dziLevelSize(P, 17)).toEqual({ width: 100_000, height: 80_000 });
    expect(dziLevelSize(P, 10)).toEqual({ width: 782, height: 625 });
  });

  it('chooses the coarsest level at or above the requested resolution', () => {
    expect(chooseLevel(P, 1)).toBe(17);
    expect(chooseLevel(P, 0.5)).toBe(16);
    expect(chooseLevel(P, 0.3)).toBe(16); // 0.5 >= 0.3 > 0.25
    expect(chooseLevel(P, 1 / 16)).toBe(13);
    expect(chooseLevel(P, 4)).toBe(17); // never above full resolution
  });
});

describe('planRegionRead', () => {
  it('covers the request with tile cores exactly once', () => {
    const region = { x: 40_000, y: 30_000, width: 24_000, height: 13_500 };
    const plan = planRegionRead(P, region, 1024, 576);
    expect(plan.level).toBe(13); // 1024/24000 = 0.0427 -> 1/16
    let area = 0;
    for (const t of plan.tiles) {
      area += t.w * t.h;
      expect(t.sx).toBeGreaterThanOrEqual(0);
      expect(t.sx + t.w).toBeLessThanOrEqual(256);
    }
    expect(area).toBe(plan.levelRect.width * plan.levelRect.height);
    expect(plan.crop.width).toBeCloseTo(1500, 6);
    // ~1500 x 844 level px -> 7 x 5 (or 4) tiles
    expect(plan.tiles.length).toBeGreaterThanOrEqual(28);
    expect(plan.tiles.length).toBeLessThanOrEqual(42);
  });

  it('accounts for the overlap only after the first row/column', () => {
    const plan = planRegionRead(P, { x: 0, y: 0, width: 600, height: 300 }, 600, 300);
    const first = plan.tiles.find((t) => t.tx === 0 && t.ty === 0)!;
    const second = plan.tiles.find((t) => t.tx === 1 && t.ty === 0)!;
    expect(first.sx).toBe(0);
    expect(second.sx).toBe(1);
    expect(second.dx).toBe(254);
  });
});

describe('describeOsdTileSource', () => {
  it('derives a URL template from a DZI-like tile source', () => {
    const ts = {
      width: P.width,
      height: P.height,
      tileOverlap: 1,
      maxLevel: 17,
      getTileWidth: () => 254,
      getTileUrl: (l: number, x: number, y: number) => `/synth/gigapixel_files/${l}/${x}_${y}.jpeg?v=2`,
    };
    expect(describeOsdTileSource(ts)).toEqual({ ...P, tileUrlTemplate: `${P.tileUrlTemplate}?v=2` });
  });

  it('describes a plain image source', () => {
    expect(describeOsdTileSource({ width: 800, height: 600, url: '/a.png', type: 'image' })).toEqual({
      kind: 'image',
      width: 800,
      height: 600,
      url: '/a.png',
    });
  });

  it('refuses sources it cannot describe', () => {
    expect(describeOsdTileSource({ width: 800, height: 600, maxLevel: 10, getTileUrl: () => '/static' })).toBeNull();
  });
});
