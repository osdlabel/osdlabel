import { type SetStoreFunction, produce } from 'solid-js/store';
import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { AnnotationState, ImageId, UIState } from '@osdlabel/viewer-api';
import type {
  AnnotationContext,
  AnnotationContextId,
  ContextState,
} from '@osdlabel/annotation-context';
import type { OsdAnnotation, OsdFields } from 'osdlabel';
import {
  applyAnnotationAction,
  applyUIAction,
  applyContextAction,
  validateAddAnnotation,
} from 'osdlabel';

export function createActions(
  setAnnotationState: SetStoreFunction<AnnotationState<OsdFields>>,
  setUIState: SetStoreFunction<UIState>,
  setContextState: SetStoreFunction<ContextState>,
  contextState: ContextState,
  uiState: UIState,
) {
  function addAnnotation(annotation: Omit<OsdAnnotation, 'createdAt' | 'updatedAt'>): void {
    if (!validateAddAnnotation(annotation, contextState)) return;
    setAnnotationState(
      produce((draft) =>
        applyAnnotationAction(draft, { type: 'ADD_ANNOTATION', payload: annotation }),
      ),
    );
  }

  function updateAnnotation(
    id: AnnotationId,
    imageId: ImageId,
    patch: Partial<Omit<OsdAnnotation, 'id' | 'imageId' | 'createdAt' | 'updatedAt'>>,
  ): void {
    setAnnotationState(
      produce((draft) =>
        applyAnnotationAction(draft, {
          type: 'UPDATE_ANNOTATION',
          payload: { id, imageId, patch },
        }),
      ),
    );
  }

  function deleteAnnotation(id: AnnotationId, imageId: ImageId): void {
    setAnnotationState(
      produce((draft) =>
        applyAnnotationAction(draft, { type: 'DELETE_ANNOTATION', payload: { id, imageId } }),
      ),
    );
  }

  function setActiveTool(tool: ToolType | 'select' | null): void {
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'SET_ACTIVE_TOOL', payload: tool })),
    );
  }

  function setActiveCell(cellIndex: number): void {
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'SET_ACTIVE_CELL', payload: cellIndex })),
    );
  }

  function setSelectedAnnotation(id: AnnotationId | null): void {
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'SET_SELECTED_ANNOTATION', payload: id })),
    );
  }

  function assignImageToCell(cellIndex: number, imageId: ImageId): void {
    setUIState(
      produce((draft) =>
        applyUIAction(draft, { type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex, imageId } }),
      ),
    );
  }

  function setGridDimensions(columns: number, rows: number): void {
    setUIState(
      produce((draft) =>
        applyUIAction(draft, { type: 'SET_GRID_DIMENSIONS', payload: { columns, rows } }),
      ),
    );
  }

  function setContexts(contexts: AnnotationContext[]): void {
    setContextState(
      produce((draft) => applyContextAction(draft, { type: 'SET_CONTEXTS', payload: contexts })),
    );
  }

  function setActiveContext(contextId: AnnotationContextId | null): void {
    setContextState(
      produce((draft) =>
        applyContextAction(draft, { type: 'SET_ACTIVE_CONTEXT', payload: contextId }),
      ),
    );
  }

  function setDisplayedContexts(contextIds: AnnotationContextId[]): void {
    setContextState(
      produce((draft) =>
        applyContextAction(draft, { type: 'SET_DISPLAYED_CONTEXTS', payload: contextIds }),
      ),
    );
  }

  function loadAnnotations(byImage: Record<ImageId, Record<AnnotationId, OsdAnnotation>>): void {
    setAnnotationState(
      produce((draft) =>
        applyAnnotationAction(draft, { type: 'LOAD_ANNOTATIONS', payload: byImage }),
      ),
    );
  }

  function rotateActiveImageCW(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'ROTATE_CW', payload: { cellIndex } })),
    );
  }

  function rotateActiveImageCCW(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'ROTATE_CCW', payload: { cellIndex } })),
    );
  }

  function flipActiveImageH(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'FLIP_H', payload: { cellIndex } })),
    );
  }

  function flipActiveImageV(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'FLIP_V', payload: { cellIndex } })),
    );
  }

  function toggleActiveImageNegative(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'TOGGLE_NEGATIVE', payload: { cellIndex } })),
    );
  }

  function increaseActiveImageExposure(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) =>
        applyUIAction(draft, { type: 'INCREASE_EXPOSURE', payload: { cellIndex } }),
      ),
    );
  }

  function decreaseActiveImageExposure(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) =>
        applyUIAction(draft, { type: 'DECREASE_EXPOSURE', payload: { cellIndex } }),
      ),
    );
  }

  function setActiveImageExposure(value: number): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) =>
        applyUIAction(draft, { type: 'SET_EXPOSURE', payload: { cellIndex, value } }),
      ),
    );
  }

  function resetActiveImageView(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((draft) => applyUIAction(draft, { type: 'RESET_VIEW', payload: { cellIndex } })),
    );
  }

  return {
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    setActiveTool,
    setActiveCell,
    setSelectedAnnotation,
    assignImageToCell,
    setGridDimensions,
    setContexts,
    setActiveContext,
    setDisplayedContexts,
    loadAnnotations,
    rotateActiveImageCW,
    rotateActiveImageCCW,
    flipActiveImageH,
    flipActiveImageV,
    toggleActiveImageNegative,
    increaseActiveImageExposure,
    decreaseActiveImageExposure,
    setActiveImageExposure,
    resetActiveImageView,
  };
}
