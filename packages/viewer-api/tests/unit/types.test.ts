import { describe, it, expect } from 'vitest';
import { DEFAULT_CELL_TRANSFORM } from '../../src/index.js';
import type { CellTransform, UIState, KeyboardShortcutMap } from '../../src/index.js';

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
