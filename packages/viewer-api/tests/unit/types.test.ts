import { describe, it, expect } from 'vitest';
import { DEFAULT_CELL_TRANSFORM, createImageId } from '../../src/index.js';
import type { CellTransform, UIState, KeyboardShortcutMap, ImageId } from '../../src/index.js';

describe('viewer-api types', () => {
  it('DEFAULT_CELL_TRANSFORM has correct defaults', () => {
    expect(DEFAULT_CELL_TRANSFORM).toEqual({
      rotation: 0,
      flippedH: false,
      flippedV: false,
      exposure: 0,
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
