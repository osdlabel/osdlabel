import { useEffect, useCallback } from 'react';
import type { KeyboardShortcutMap, ImageId, UIState } from '@osdlabel/viewer-api';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import { mapKeyEventToActions, DEFAULT_KEYBOARD_SHORTCUTS, MAX_GRID_SIZE } from 'osdlabel';
import type { AnnotationAction, ContextAction, UIAction } from 'osdlabel';
import type { ActiveToolKeyHandlerRef } from '../state/annotator-context.js';
import type { createActions } from '../state/actions.js';

export { MAX_GRID_SIZE, DEFAULT_KEYBOARD_SHORTCUTS };

export function useKeyboard(
  shortcuts: KeyboardShortcutMap,
  activeToolKeyHandlerRef: ActiveToolKeyHandlerRef,
  actions: ReturnType<typeof createActions>,
  uiState: UIState,
  contextState: ContextState,
  activeImageId: ImageId | undefined,
  constraintStatus: ConstraintStatus,
  shouldSkipTargetPredicate?: (target: HTMLElement) => boolean,
) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
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
          activeImageId,
          contexts: contextState.contexts,
          activeContextId: contextState.activeContextId,
        },
        constraintStatus,
      );

      for (const action of mappedActions) {
        dispatchAction(actions, action);
      }
    },
    [
      shortcuts,
      activeToolKeyHandlerRef,
      actions,
      uiState,
      // Depend on the two fields actually read rather than the whole
      // contextState, so a `displayedContextIds` change doesn't resubscribe.
      contextState.contexts,
      contextState.activeContextId,
      activeImageId,
      constraintStatus,
      shouldSkipTargetPredicate,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

function dispatchAction(
  actions: ReturnType<typeof createActions>,
  action: UIAction | AnnotationAction | ContextAction,
): void {
  switch (action.type) {
    case 'SET_ACTIVE_CONTEXT':
      actions.setActiveContext(action.payload);
      break;
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
