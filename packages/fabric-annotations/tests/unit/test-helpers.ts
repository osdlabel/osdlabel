import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';

/**
 * A complete {@link KeyboardShortcutMap} for tests.
 *
 * Kept exhaustive by hand rather than derived from `DEFAULT_KEYBOARD_SHORTCUTS`,
 * which lives in `osdlabel` — a package this one must not depend on. Test files
 * are excluded from `tsc --noEmit`, so a missing key here is invisible until a
 * tool reads it and gets `undefined`; add new keys when the map grows.
 */
export function createTestKeyboardShortcuts(): KeyboardShortcutMap {
  return {
    selectTool: 'v',
    rectangleTool: 'r',
    circleTool: 'c',
    lineTool: 'l',
    pointTool: 'p',
    polylineTool: 'd',
    freeHandPathTool: 'f',
    segmentationBrushTool: 'b',
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
    increaseGridColumns: '=',
    decreaseGridColumns: '-',
    increaseGridRows: ']',
    decreaseGridRows: '[',
    polylineFinish: 'Enter',
    polylineClose: 'c',
    polylineCancel: 'Escape',
    rotateCW: 'R',
    rotateCCW: 'L',
    flipHorizontal: 'H',
    flipVertical: 'V',
    resetView: ')',
    toggleNegative: 'N',
    increaseExposure: 'E',
    decreaseExposure: 'D',
    increaseContrast: 'C',
    decreaseContrast: 'X',
    increaseBrushRadius: ']',
    decreaseBrushRadius: '[',
    nextContext: '.',
    previousContext: ',',
  };
}
