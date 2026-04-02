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

  it('CellTransform is assignable from DEFAULT_CELL_TRANSFORM', () => {
    const ct: CellTransform = DEFAULT_CELL_TRANSFORM;
    expect(ct.rotation).toBe(0);
  });

  it('UIState type is structurally valid', () => {
    // Type-level check — ensures UIState compiles with expected fields
    const state: UIState = {
      activeTool: null,
      activeCellIndex: 0,
      gridColumns: 1,
      gridRows: 1,
      gridAssignments: {},
      selectedAnnotationId: null,
      cellTransforms: {},
    };
    expect(state.activeTool).toBeNull();
  });

  it('KeyboardShortcutMap type is structurally valid', () => {
    // Type-level check — ensures all required fields exist
    const map: KeyboardShortcutMap = {
      selectTool: 'v',
      rectangleTool: 'r',
      circleTool: 'c',
      lineTool: 'l',
      pointTool: 'p',
      polylineTool: 'a',
      freeHandPathTool: 'f',
      cancel: 'Escape',
      delete: 'Delete',
      deleteAlt: 'Backspace',
      gridCell1: '1',
      gridCell2: '2',
      gridCell3: '3',
      gridCell4: '4',
      gridCell5: '5',
      gridCell6: '6',
      gridCell7: '7',
      gridCell8: '8',
      gridCell9: '9',
      increaseGridColumns: ']',
      decreaseGridColumns: '[',
      increaseGridRows: '}',
      decreaseGridRows: '{',
      polylineFinish: 'Enter',
      polylineClose: 'c',
      polylineCancel: 'Escape',
      rotateCW: 'e',
      rotateCCW: 'q',
      flipHorizontal: 'h',
      flipVertical: 'j',
      resetView: '0',
      toggleNegative: 'i',
      increaseExposure: '=',
      decreaseExposure: '-',
    };
    expect(map.selectTool).toBe('v');
  });
});
