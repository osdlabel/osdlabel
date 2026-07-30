import { onMount, onCleanup } from 'solid-js';
import { useAnnotator, type ActiveToolKeyHandlerRef } from '../state/annotator-context.js';
import { useConstraints } from './useConstraints.js';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { mapKeyEventToActions, MAX_GRID_SIZE, DEFAULT_KEYBOARD_SHORTCUTS } from 'osdlabel';
import type { AnnotationAction, UIAction } from 'osdlabel';

export { MAX_GRID_SIZE, DEFAULT_KEYBOARD_SHORTCUTS };

export function useKeyboard(
  shortcuts: KeyboardShortcutMap,
  activeToolKeyHandlerRef: ActiveToolKeyHandlerRef,
  shouldSkipTargetPredicate?: (target: HTMLElement) => boolean,
) {
  const { actions, uiState, activeImageId, constraintStatus } = useAnnotator();
  const { isToolEnabled: _isToolEnabled } = useConstraints();

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

    const mappedActions = mapKeyEventToActions(
      e.key,
      e.shiftKey,
      shortcuts,
      {
        activeTool: uiState.activeTool,
        activeCellIndex: uiState.activeCellIndex,
        gridColumns: uiState.gridColumns,
        gridRows: uiState.gridRows,
        selectedAnnotationId: uiState.selectedAnnotationId,
        activeImageId: activeImageId(),
      },
      constraintStatus(),
    );

    for (const action of mappedActions) {
      dispatchAction(actions, action);
    }
  };

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown);
  });
}

function dispatchAction(
  actions: ReturnType<typeof import('../state/actions.js').createActions>,
  action: UIAction | AnnotationAction,
): void {
  switch (action.type) {
    case 'SET_ACTIVE_TOOL':
      actions.setActiveTool(action.payload);
      break;
    case 'SET_ACTIVE_CELL':
      actions.setActiveCell(action.payload);
      break;
    case 'SET_SELECTED_ANNOTATION':
      actions.setSelectedAnnotation(action.payload);
      break;
    case 'SET_GRID_DIMENSIONS':
      actions.setGridDimensions(action.payload.columns, action.payload.rows);
      break;
    case 'ROTATE_CW':
      actions.rotateActiveImageCW();
      break;
    case 'ROTATE_CCW':
      actions.rotateActiveImageCCW();
      break;
    case 'FLIP_H':
      actions.flipActiveImageH();
      break;
    case 'FLIP_V':
      actions.flipActiveImageV();
      break;
    case 'TOGGLE_NEGATIVE':
      actions.toggleActiveImageNegative();
      break;
    case 'INCREASE_EXPOSURE':
      actions.increaseActiveImageExposure();
      break;
    case 'DECREASE_EXPOSURE':
      actions.decreaseActiveImageExposure();
      break;
    case 'INCREASE_CONTRAST':
      actions.increaseActiveImageContrast();
      break;
    case 'DECREASE_CONTRAST':
      actions.decreaseActiveImageContrast();
      break;
    case 'RESET_VIEW':
      actions.resetActiveImageView();
      break;
    case 'DELETE_ANNOTATION':
      actions.deleteAnnotation(action.payload.id, action.payload.imageId);
      break;
    default:
      break;
  }
}
