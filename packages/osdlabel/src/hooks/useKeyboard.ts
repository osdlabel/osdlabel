import { onMount, onCleanup } from 'solid-js';
import { useAnnotator, type ActiveToolKeyHandlerRef } from '../state/annotator-context.js';
import { useConstraints } from './useConstraints.js';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  selectTool: 'v',
  rectangleTool: 'r',
  circleTool: 'c',
  lineTool: 'l',
  pointTool: 'p',
  polylineTool: 'd',
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
} as const;

/** Maximum grid size */
export const MAX_GRID_SIZE = {
  columns: 4,
  rows: 4,
} as const;

export function useKeyboard(
  shortcuts: KeyboardShortcutMap,
  activeToolKeyHandlerRef: ActiveToolKeyHandlerRef,
  shouldSkipTargetPredicate?: (target: HTMLElement) => boolean,
) {
  const { actions, uiState, activeImageId } = useAnnotator();
  const { isToolEnabled } = useConstraints();

  const handleKeyDown = (e: KeyboardEvent) => {
    // Suppress shortcuts if typing in input/textarea/contenteditable
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      shouldSkipTargetPredicate?.(target)
    ) {
      return;
    }

    if (activeToolKeyHandlerRef.handler) {
      const consumed = activeToolKeyHandlerRef.handler(e);
      if (consumed) return;
    }

    const key = e.key;
    const keyLower = key.toLowerCase();

    // View Transforms (Shift+Key) - must come before tools to avoid interference
    if (e.shiftKey && keyLower === shortcuts.rotateCW.toLowerCase()) {
      actions.rotateActiveImageCW();
    } else if (e.shiftKey && keyLower === shortcuts.rotateCCW.toLowerCase()) {
      actions.rotateActiveImageCCW();
    } else if (e.shiftKey && keyLower === shortcuts.flipHorizontal.toLowerCase()) {
      actions.flipActiveImageH();
    } else if (e.shiftKey && keyLower === shortcuts.flipVertical.toLowerCase()) {
      actions.flipActiveImageV();
    } else if (e.shiftKey && keyLower === shortcuts.toggleNegative.toLowerCase()) {
      actions.toggleActiveImageNegative();
    } else if (e.shiftKey && keyLower === shortcuts.increaseExposure.toLowerCase()) {
      actions.increaseActiveImageExposure();
    } else if (e.shiftKey && keyLower === shortcuts.decreaseExposure.toLowerCase()) {
      actions.decreaseActiveImageExposure();
    } else if (key === shortcuts.resetView || (e.shiftKey && keyLower === '0')) {
      actions.resetActiveImageView();
    }

    // Tools
    else if (!e.shiftKey && keyLower === shortcuts.selectTool.toLowerCase()) {
      actions.setActiveTool('select');
    } else if (!e.shiftKey && keyLower === shortcuts.rectangleTool.toLowerCase()) {
      if (isToolEnabled('rectangle')) actions.setActiveTool('rectangle');
    } else if (!e.shiftKey && keyLower === shortcuts.circleTool.toLowerCase()) {
      if (isToolEnabled('circle')) actions.setActiveTool('circle');
    } else if (!e.shiftKey && keyLower === shortcuts.lineTool.toLowerCase()) {
      if (isToolEnabled('line')) actions.setActiveTool('line');
    } else if (!e.shiftKey && keyLower === shortcuts.pointTool.toLowerCase()) {
      if (isToolEnabled('point')) actions.setActiveTool('point');
    } else if (!e.shiftKey && keyLower === shortcuts.polylineTool.toLowerCase()) {
      if (isToolEnabled('polyline')) actions.setActiveTool('polyline');
    } else if (!e.shiftKey && keyLower === shortcuts.freeHandPathTool.toLowerCase()) {
      if (isToolEnabled('freeHandPath')) actions.setActiveTool('freeHandPath');
    }

    // Cancel / Escape
    else if (key === shortcuts.cancel) {
      if (uiState.selectedAnnotationId !== null) {
        actions.setSelectedAnnotation(null);
      } else {
        actions.setActiveTool(null);
      }
    }

    // Delete
    else if (key === shortcuts.delete || key === shortcuts.deleteAlt) {
      const imgId = activeImageId();
      if (uiState.selectedAnnotationId && imgId) {
        actions.deleteAnnotation(uiState.selectedAnnotationId, imgId);
        actions.setSelectedAnnotation(null);
      }
    }

    // Grid Cells
    else if (key === shortcuts.gridCell1) actions.setActiveCell(0);
    else if (key === shortcuts.gridCell2) actions.setActiveCell(1);
    else if (key === shortcuts.gridCell3) actions.setActiveCell(2);
    else if (key === shortcuts.gridCell4) actions.setActiveCell(3);
    else if (key === shortcuts.gridCell5) actions.setActiveCell(4);
    else if (key === shortcuts.gridCell6) actions.setActiveCell(5);
    else if (key === shortcuts.gridCell7) actions.setActiveCell(6);
    else if (key === shortcuts.gridCell8) actions.setActiveCell(7);
    else if (key === shortcuts.gridCell9) actions.setActiveCell(8);
    // Grid Columns
    else if (
      key === shortcuts.increaseGridColumns ||
      (shortcuts.increaseGridColumns === '=' && key === '+')
    ) {
      const maxCols = MAX_GRID_SIZE.columns;
      if (uiState.gridColumns < maxCols) {
        actions.setGridDimensions(uiState.gridColumns + 1, uiState.gridRows);
      }
    } else if (key === shortcuts.decreaseGridColumns) {
      if (uiState.gridColumns > 1) {
        actions.setGridDimensions(uiState.gridColumns - 1, uiState.gridRows);
      }
    }
    // Grid Rows
    else if (key === shortcuts.increaseGridRows) {
      const maxRows = MAX_GRID_SIZE.rows;
      if (uiState.gridRows < maxRows) {
        actions.setGridDimensions(uiState.gridColumns, uiState.gridRows + 1);
      }
    } else if (key === shortcuts.decreaseGridRows) {
      if (uiState.gridRows > 1) {
        actions.setGridDimensions(uiState.gridColumns, uiState.gridRows - 1);
      }
    }
  };

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown);
  });
}
