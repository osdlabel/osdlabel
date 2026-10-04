import { describe, it, expect } from 'vitest';
import { DEFAULT_CELL_TRANSFORM, createImageId } from '../../src/index.js';
import type { ImageId, ImageSource, TileSourceSpec } from '../../src/index.js';

describe('viewer-api types', () => {
  it('DEFAULT_CELL_TRANSFORM has correct defaults', () => {
    expect(DEFAULT_CELL_TRANSFORM).toEqual({
      rotation: 0,
      flippedH: false,
      flippedV: false,
      exposure: 0,
      contrast: 0,
      inverted: false,
    });
  });
});

describe('ImageId branded type', () => {
  it('createImageId produces a branded value', () => {
    const id = createImageId('img-1');
    expect(id).toBe('img-1');
    const asString: string = id;
    expect(asString).toBe('img-1');
  });

  it('branded type is not assignable from raw string', () => {
    // @ts-expect-error - raw string cannot be assigned to ImageId
    const _imgId: ImageId = 'raw-string';
    void _imgId;
  });

  it('createImageId returns a value that satisfies ImageId', () => {
    const id = createImageId('test-id');
    const acceptsImageId = (iid: ImageId) => iid;
    expect(acceptsImageId(id)).toBe('test-id');
  });
});

describe('ImageSource.tileSource (#83)', () => {
  /** Shaped like OpenSeadragon's `TileSourceOptions`: an interface, so no implicit index signature. */
  interface TileSourceOptionsLike {
    readonly type: string;
    readonly url: string;
    readonly buildPyramid?: boolean;
  }

  it('accepts a URL, an interface-typed options object and a class instance', () => {
    const options: TileSourceOptionsLike = { type: 'image', url: 'a.png', buildPyramid: false };
    class TileSourceLike {
      constructor(readonly url: string) {}
    }
    const sources: ImageSource[] = [
      { id: createImageId('url'), tileSource: 'slide.dzi' },
      { id: createImageId('options'), tileSource: options },
      { id: createImageId('instance'), tileSource: new TileSourceLike('slide.dzi') },
    ];
    expect(sources.map((s) => typeof s.tileSource)).toEqual(['string', 'object', 'object']);
  });

  it('rejects primitives other than strings', () => {
    const spec = (value: TileSourceSpec): TileSourceSpec => value;
    // @ts-expect-error a number is not a tile source
    expect(spec(42)).toBe(42);
    // @ts-expect-error nor is null
    expect(spec(null)).toBeNull();
  });
});
