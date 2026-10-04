import { describe, it, expect } from 'vitest';
import { isSameTileSource } from '../../src/same-tile-source.js';

describe('isSameTileSource (#83)', () => {
  it('compares strings exactly', () => {
    expect(isSameTileSource('a.dzi', 'a.dzi')).toBe(true);
    expect(isSameTileSource('a.dzi', 'b.dzi')).toBe(false);
  });

  it('treats undefined as a value of its own', () => {
    expect(isSameTileSource(undefined, undefined)).toBe(true);
    expect(isSameTileSource(undefined, 'a.dzi')).toBe(false);
    expect(isSameTileSource({ type: 'image', url: 'a.png' }, undefined)).toBe(false);
  });

  it('never equates a string with an object', () => {
    expect(isSameTileSource('a.png', { type: 'image', url: 'a.png' })).toBe(false);
  });

  it('compares re-created plain objects by value, nested included', () => {
    expect(
      isSameTileSource(
        { type: 'image', url: 'a.png', buildPyramid: false },
        { buildPyramid: false, url: 'a.png', type: 'image' },
      ),
    ).toBe(true);
    expect(
      isSameTileSource(
        { Image: { Url: 'x/', Size: { Width: '10', Height: '20' } } },
        { Image: { Url: 'x/', Size: { Width: '10', Height: '20' } } },
      ),
    ).toBe(true);
  });

  it('sees a changed, added or removed field', () => {
    const base = { type: 'image', url: 'a.png' };
    expect(isSameTileSource(base, { type: 'image', url: 'b.png' })).toBe(false);
    expect(isSameTileSource(base, { ...base, buildPyramid: false })).toBe(false);
    expect(isSameTileSource({ ...base, buildPyramid: false }, base)).toBe(false);
    expect(
      isSameTileSource({ Image: { Size: { Width: '10' } } }, { Image: { Size: { Width: '11' } } }),
    ).toBe(false);
  });

  it('compares arrays element by element', () => {
    expect(isSameTileSource(['a.dzi', { url: 'b.png' }], ['a.dzi', { url: 'b.png' }])).toBe(true);
    expect(isSameTileSource(['a.dzi'], ['a.dzi', 'b.dzi'])).toBe(false);
    expect(isSameTileSource(['a.dzi'], { 0: 'a.dzi' })).toBe(false);
  });

  it('compares functions by identity, so a new getTileUrl reloads', () => {
    const getTileUrl = (level: number) => `t/${level}`;
    expect(isSameTileSource({ getTileUrl }, { getTileUrl })).toBe(true);
    expect(isSameTileSource({ getTileUrl }, { getTileUrl: (level: number) => `t/${level}` })).toBe(
      false,
    );
  });

  it('compares class instances, such as a TileSource, by identity', () => {
    class FakeTileSource {
      constructor(readonly url: string) {}
    }
    const source = new FakeTileSource('a.dzi');
    expect(isSameTileSource(source, source)).toBe(true);
    expect(isSameTileSource(source, new FakeTileSource('a.dzi'))).toBe(false);
  });
});
