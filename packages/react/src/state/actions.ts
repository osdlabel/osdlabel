import type { Dispatch } from 'react';
import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { ImageId, ViewerControlId } from '@osdlabel/viewer-api';
import type {
  AnnotationContext,
  AnnotationContextId,
  ContextState,
} from '@osdlabel/annotation-context';
import type { OsdAnnotation, AnnotationAction, UIAction, ContextAction } from 'osdlabel';
import { validateAddAnnotation } from 'osdlabel';

export function createActions(
  dispatchAnnotation: Dispatch<AnnotationAction>,
  dispatchUI: Dispatch<UIAction>,
  dispatchContext: Dispatch<ContextAction>,
  getContextState: () => ContextState,
  getUIState: () => { activeCellIndex: number },
) {
  function addAnnotation(annotation: Omit<OsdAnnotation, 'createdAt' | 'updatedAt'>): void {
    if (!validateAddAnnotation(annotation, getContextState())) return;
    dispatchAnnotation({ type: 'ADD_ANNOTATION', payload: annotation });
  }

  function updateAnnotation(
    id: AnnotationId,
    imageId: ImageId,
    patch: Partial<Omit<OsdAnnotation, 'id' | 'imageId' | 'createdAt' | 'updatedAt'>>,
  ): void {
    dispatchAnnotation({ type: 'UPDATE_ANNOTATION', payload: { id, imageId, patch } });
  }

  function deleteAnnotation(id: AnnotationId, imageId: ImageId): void {
    dispatchAnnotation({ type: 'DELETE_ANNOTATION', payload: { id, imageId } });
  }

  function setActiveTool(tool: ToolType | 'select' | null): void {
    dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: tool });
  }

  function setActiveViewerControl(control: ViewerControlId | null): void {
    dispatchUI({ type: 'SET_ACTIVE_VIEWER_CONTROL', payload: control });
  }

  function setActiveCell(cellIndex: number): void {
    dispatchUI({ type: 'SET_ACTIVE_CELL', payload: cellIndex });
  }

  function setSelectedAnnotation(id: AnnotationId | null): void {
    dispatchUI({ type: 'SET_SELECTED_ANNOTATION', payload: id });
  }

  function assignImageToCell(cellIndex: number, imageId: ImageId): void {
    dispatchUI({ type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex, imageId } });
  }

  function setGridDimensions(columns: number, rows: number): void {
    dispatchUI({ type: 'SET_GRID_DIMENSIONS', payload: { columns, rows } });
  }

  function setContexts(contexts: AnnotationContext[]): void {
    dispatchContext({ type: 'SET_CONTEXTS', payload: contexts });
  }

  function setActiveContext(contextId: AnnotationContextId | null): void {
    dispatchContext({ type: 'SET_ACTIVE_CONTEXT', payload: contextId });
  }

  function setDisplayedContexts(contextIds: AnnotationContextId[]): void {
    dispatchContext({ type: 'SET_DISPLAYED_CONTEXTS', payload: contextIds });
  }

  function loadAnnotations(byImage: Record<ImageId, Record<AnnotationId, OsdAnnotation>>): void {
    dispatchAnnotation({ type: 'LOAD_ANNOTATIONS', payload: byImage });
  }

  function rotateActiveImageCW(): void {
    dispatchUI({ type: 'ROTATE_CW', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function rotateActiveImageCCW(): void {
    dispatchUI({ type: 'ROTATE_CCW', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function flipActiveImageH(): void {
    dispatchUI({ type: 'FLIP_H', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function flipActiveImageV(): void {
    dispatchUI({ type: 'FLIP_V', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function toggleActiveImageNegative(): void {
    dispatchUI({ type: 'TOGGLE_NEGATIVE', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function increaseActiveImageExposure(): void {
    dispatchUI({ type: 'INCREASE_EXPOSURE', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function decreaseActiveImageExposure(): void {
    dispatchUI({ type: 'DECREASE_EXPOSURE', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  function setActiveImageExposure(value: number): void {
    dispatchUI({
      type: 'SET_EXPOSURE',
      payload: { cellIndex: getUIState().activeCellIndex, value },
    });
  }

  function resetActiveImageView(): void {
    dispatchUI({ type: 'RESET_VIEW', payload: { cellIndex: getUIState().activeCellIndex } });
  }

  return {
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    setActiveTool,
    setActiveViewerControl,
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
