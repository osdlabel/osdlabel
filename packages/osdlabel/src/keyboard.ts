import type { ToolType, AnnotationId } from '@osdlabel/annotation';
import type { KeyboardShortcutMap, ImageId } from '@osdlabel/viewer-api';
import type {
  AnnotationContext,
  AnnotationContextId,
  ConstraintStatus,
} from '@osdlabel/annotation-context';
import type { UIAction, AnnotationAction, ContextAction } from './actions.js';
import { getCycledContextId } from './context-cycling.js';

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  selectTool: 'v',
  rectangleTool: 'r',
  circleTool: 'c',
  lineTool: 'l',
  pointTool: 'p',
  polylineTool: 'd',
  freeHandPathTool: 'f',
  segmentationTool: 's',
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
  nextContext: '.',
  previousContext: ',',
} as const;

/** Maximum grid size */
export const MAX_GRID_SIZE = {
  columns: 4,
  rows: 4,
} as const;

/**
 * Input state needed to map a keyboard event to actions.
 */
export interface KeyboardMappingState {
  readonly activeTool: ToolType | 'select' | null;
  readonly activeCellIndex: number;
  readonly gridColumns: number;
  readonly gridRows: number;
  readonly selectedAnnotationId: AnnotationId | null;
  readonly activeImageId: ImageId | undefined;
  /**
   * Annotation contexts in configured order — the ring the context-cycling
   * shortcuts step through. Omit (or pass an empty array) to disable cycling.
   */
  readonly contexts?: readonly AnnotationContext[] | undefined;
  readonly activeContextId?: AnnotationContextId | null | undefined;
}

/**
 * Pure function that maps a keyboard event to zero or more actions.
 * Returns null if the event should be ignored (e.g., typing in an input).
 * Returns an empty array if the key doesn't match any shortcut.
 *
 * The caller is responsible for:
 * 1. Checking shouldSkipTarget
 * 2. Passing the event to activeToolKeyHandler first
 * 3. Dispatching the returned actions
 */
export function mapKeyEventToActions(
  key: string,
  shiftKey: boolean,
  shortcuts: KeyboardShortcutMap,
  state: KeyboardMappingState,
  constraintStatus: ConstraintStatus,
): readonly (UIAction | AnnotationAction | ContextAction)[] {
  const keyLower = key.toLowerCase();
  const actions: (UIAction | AnnotationAction | ContextAction)[] = [];

  // View Transforms (Shift+Key)
  if (shiftKey && keyLower === shortcuts.rotateCW.toLowerCase()) {
    actions.push({ type: 'ROTATE_CW', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.rotateCCW.toLowerCase()) {
    actions.push({ type: 'ROTATE_CCW', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.flipHorizontal.toLowerCase()) {
    actions.push({ type: 'FLIP_H', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.flipVertical.toLowerCase()) {
    actions.push({ type: 'FLIP_V', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.toggleNegative.toLowerCase()) {
    actions.push({ type: 'TOGGLE_NEGATIVE', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.increaseExposure.toLowerCase()) {
    actions.push({ type: 'INCREASE_EXPOSURE', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.decreaseExposure.toLowerCase()) {
    actions.push({ type: 'DECREASE_EXPOSURE', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.increaseContrast.toLowerCase()) {
    actions.push({ type: 'INCREASE_CONTRAST', payload: { cellIndex: state.activeCellIndex } });
  } else if (shiftKey && keyLower === shortcuts.decreaseContrast.toLowerCase()) {
    actions.push({ type: 'DECREASE_CONTRAST', payload: { cellIndex: state.activeCellIndex } });
  } else if (key === shortcuts.resetView || (shiftKey && keyLower === '0')) {
    actions.push({ type: 'RESET_VIEW', payload: { cellIndex: state.activeCellIndex } });
  }

  // Tools
  else if (!shiftKey && keyLower === shortcuts.selectTool.toLowerCase()) {
    actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'select' });
  } else if (!shiftKey && keyLower === shortcuts.rectangleTool.toLowerCase()) {
    if (constraintStatus.rectangle.enabled)
      actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'rectangle' });
  } else if (!shiftKey && keyLower === shortcuts.circleTool.toLowerCase()) {
    if (constraintStatus.circle.enabled)
      actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'circle' });
  } else if (!shiftKey && keyLower === shortcuts.lineTool.toLowerCase()) {
    if (constraintStatus.line.enabled) actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'line' });
  } else if (!shiftKey && keyLower === shortcuts.pointTool.toLowerCase()) {
    if (constraintStatus.point.enabled) actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'point' });
  } else if (!shiftKey && keyLower === shortcuts.polylineTool.toLowerCase()) {
    if (constraintStatus.polyline.enabled)
      actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'polyline' });
  } else if (!shiftKey && keyLower === shortcuts.freeHandPathTool.toLowerCase()) {
    if (constraintStatus.freeHandPath.enabled)
      actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'freeHandPath' });
  } else if (!shiftKey && keyLower === shortcuts.segmentationTool.toLowerCase()) {
    if (constraintStatus.segmentation.enabled)
      actions.push({ type: 'SET_ACTIVE_TOOL', payload: 'segmentation' });
  }

  // Cancel / Escape
  else if (key === shortcuts.cancel) {
    if (state.selectedAnnotationId !== null) {
      actions.push({ type: 'SET_SELECTED_ANNOTATION', payload: null });
    } else {
      actions.push({ type: 'SET_ACTIVE_TOOL', payload: null });
    }
  }

  // Delete
  else if (key === shortcuts.delete || key === shortcuts.deleteAlt) {
    if (state.selectedAnnotationId && state.activeImageId) {
      actions.push({
        type: 'DELETE_ANNOTATION',
        payload: { id: state.selectedAnnotationId, imageId: state.activeImageId },
      });
      actions.push({ type: 'SET_SELECTED_ANNOTATION', payload: null });
    }
  }

  // Grid Cells
  else if (key === shortcuts.gridCell1) actions.push({ type: 'SET_ACTIVE_CELL', payload: 0 });
  else if (key === shortcuts.gridCell2) actions.push({ type: 'SET_ACTIVE_CELL', payload: 1 });
  else if (key === shortcuts.gridCell3) actions.push({ type: 'SET_ACTIVE_CELL', payload: 2 });
  else if (key === shortcuts.gridCell4) actions.push({ type: 'SET_ACTIVE_CELL', payload: 3 });
  else if (key === shortcuts.gridCell5) actions.push({ type: 'SET_ACTIVE_CELL', payload: 4 });
  else if (key === shortcuts.gridCell6) actions.push({ type: 'SET_ACTIVE_CELL', payload: 5 });
  else if (key === shortcuts.gridCell7) actions.push({ type: 'SET_ACTIVE_CELL', payload: 6 });
  else if (key === shortcuts.gridCell8) actions.push({ type: 'SET_ACTIVE_CELL', payload: 7 });
  else if (key === shortcuts.gridCell9) actions.push({ type: 'SET_ACTIVE_CELL', payload: 8 });
  // Grid Columns
  else if (
    key === shortcuts.increaseGridColumns ||
    (shortcuts.increaseGridColumns === '=' && key === '+')
  ) {
    if (state.gridColumns < MAX_GRID_SIZE.columns) {
      actions.push({
        type: 'SET_GRID_DIMENSIONS',
        payload: { columns: state.gridColumns + 1, rows: state.gridRows },
      });
    }
  } else if (key === shortcuts.decreaseGridColumns) {
    if (state.gridColumns > 1) {
      actions.push({
        type: 'SET_GRID_DIMENSIONS',
        payload: { columns: state.gridColumns - 1, rows: state.gridRows },
      });
    }
  }

  // Grid Rows
  else if (key === shortcuts.increaseGridRows) {
    if (state.gridRows < MAX_GRID_SIZE.rows) {
      actions.push({
        type: 'SET_GRID_DIMENSIONS',
        payload: { columns: state.gridColumns, rows: state.gridRows + 1 },
      });
    }
  } else if (key === shortcuts.decreaseGridRows) {
    if (state.gridRows > 1) {
      actions.push({
        type: 'SET_GRID_DIMENSIONS',
        payload: { columns: state.gridColumns, rows: state.gridRows - 1 },
      });
    }
  }

  // Annotation context cycling. The shifted variants of the default `.` / `,`
  // bindings are accepted too, mirroring the `=` / `+` grid-column handling.
  else if (
    key === shortcuts.nextContext ||
    (shortcuts.nextContext === '.' && key === '>') ||
    key === shortcuts.previousContext ||
    (shortcuts.previousContext === ',' && key === '<')
  ) {
    const direction =
      key === shortcuts.nextContext || key === '>' ? ('next' as const) : ('previous' as const);
    const activeContextId = state.activeContextId ?? null;
    const nextContextId = getCycledContextId(
      state.contexts ?? [],
      activeContextId,
      direction,
      state.activeImageId,
    );
    // Skip the dispatch when the ring is empty or has a single entry — a
    // no-op write would still bust every downstream memo.
    // The active tool is deliberately left alone: `useAnnotationTool` already
    // re-checks `constraintStatus` at draw time, so a tool the new context
    // disallows is rejected there and shown disabled in the toolbar.
    if (nextContextId !== null && nextContextId !== activeContextId) {
      actions.push({ type: 'SET_ACTIVE_CONTEXT', payload: nextContextId });
    }
  }

  return actions;
}
