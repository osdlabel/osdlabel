import { type SetStoreFunction, produce } from 'solid-js/store';
import type { AnnotationId, ImageId, ToolType } from '@osdlabel/annotation';
import type { AnnotationState } from '@osdlabel/viewer-api';
import type {
  AnnotationContext,
  AnnotationContextId,
  ContextState,
} from '@osdlabel/annotation-context';
import { isContextScopedToImage } from '@osdlabel/annotation-context';
import type { UIState } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import type { OsdAnnotation, OsdFields } from '../types.js';

export function createActions(
  setAnnotationState: SetStoreFunction<AnnotationState<OsdFields>>,
  setUIState: SetStoreFunction<UIState>,
  setContextState: SetStoreFunction<ContextState>,
  contextState: ContextState,
  uiState: UIState,
) {
  function addAnnotation(annotation: Omit<OsdAnnotation, 'createdAt' | 'updatedAt'>): void {
    const ctx = contextState.contexts.find((c) => c.id === annotation.contextId);
    if (ctx && !isContextScopedToImage(ctx, annotation.imageId)) {
      console.warn(`Context "${ctx.label}" not scoped to image "${annotation.imageId}"`);
      return;
    }

    setAnnotationState(
      produce((state) => {
        const imageAnns = state.byImage[annotation.imageId] ?? {};
        const now = new Date().toISOString();
        imageAnns[annotation.id] = {
          ...annotation,
          createdAt: now,
          updatedAt: now,
        };
        state.byImage[annotation.imageId] = imageAnns;
        state.changeCounter += 1;
      }),
    );
  }

  function updateAnnotation(
    id: AnnotationId,
    imageId: ImageId,
    patch: Partial<Omit<OsdAnnotation, 'id' | 'imageId' | 'createdAt' | 'updatedAt'>>,
  ): void {
    setAnnotationState(
      produce((state) => {
        const imageAnns = state.byImage[imageId];
        if (imageAnns && imageAnns[id]) {
          imageAnns[id] = {
            ...imageAnns[id],
            ...patch,
            updatedAt: new Date().toISOString(),
          };
          state.changeCounter += 1;
        }
      }),
    );
  }

  function deleteAnnotation(id: AnnotationId, imageId: ImageId): void {
    setAnnotationState(
      produce((state) => {
        const imageAnns = state.byImage[imageId];
        if (imageAnns) {
          delete imageAnns[id];
          state.changeCounter += 1;
        }
      }),
    );
  }

  function setActiveTool(tool: ToolType | 'select' | null): void {
    setUIState('activeTool', tool);
  }

  function setActiveCell(cellIndex: number): void {
    setUIState('activeCellIndex', cellIndex);
  }

  function setSelectedAnnotation(id: AnnotationId | null): void {
    setUIState('selectedAnnotationId', id);
  }

  function assignImageToCell(cellIndex: number, imageId: ImageId): void {
    setUIState(
      produce((state) => {
        state.gridAssignments[cellIndex] = imageId;
        // Reset visual adjustments when a new image is assigned to the cell
        state.cellTransforms[cellIndex] = { ...DEFAULT_CELL_TRANSFORM };
      }),
    );
  }

  function setGridDimensions(columns: number, rows: number): void {
    setUIState(
      produce((state) => {
        state.gridColumns = columns;
        state.gridRows = rows;

        // Prune cell transforms for cells that no longer exist in the new grid
        const maxIndex = columns * rows - 1;
        for (const indexStr of Object.keys(state.cellTransforms)) {
          const index = parseInt(indexStr, 10);
          if (index > maxIndex) {
            delete state.cellTransforms[index];
          }
        }
      }),
    );
  }

  function setContexts(contexts: AnnotationContext[]): void {
    setContextState('contexts', contexts);
  }

  function setActiveContext(contextId: AnnotationContextId | null): void {
    setContextState('activeContextId', contextId);
  }

  function setDisplayedContexts(contextIds: AnnotationContextId[]): void {
    setContextState('displayedContextIds', contextIds);
  }

  function loadAnnotations(byImage: Record<ImageId, Record<AnnotationId, OsdAnnotation>>): void {
    setAnnotationState(
      produce((state) => {
        state.byImage = byImage;
        state.changeCounter += 1;
      }),
    );
  }

  function rotateActiveImageCW(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        state.cellTransforms[cellIndex] = { ...current, rotation: (current.rotation + 90) % 360 };
      }),
    );
  }

  function rotateActiveImageCCW(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        state.cellTransforms[cellIndex] = { ...current, rotation: (current.rotation + 270) % 360 };
      }),
    );
  }

  function flipActiveImageH(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        state.cellTransforms[cellIndex] = { ...current, flippedH: !current.flippedH };
      }),
    );
  }

  function flipActiveImageV(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        state.cellTransforms[cellIndex] = { ...current, flippedV: !current.flippedV };
      }),
    );
  }

  function toggleActiveImageNegative(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        state.cellTransforms[cellIndex] = { ...current, inverted: !current.inverted };
      }),
    );
  }

  function increaseActiveImageExposure(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        const exposure = Math.min(current.exposure + 0.1, 1);
        state.cellTransforms[cellIndex] = { ...current, exposure: Math.round(exposure * 10) / 10 };
      }),
    );
  }

  function decreaseActiveImageExposure(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        const exposure = Math.max(current.exposure - 0.1, -1);
        state.cellTransforms[cellIndex] = { ...current, exposure: Math.round(exposure * 10) / 10 };
      }),
    );
  }

  function setActiveImageExposure(value: number): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        const current = state.cellTransforms[cellIndex] ?? { ...DEFAULT_CELL_TRANSFORM };
        const exposure = Math.max(Math.min(value, 1), -1);
        // Ensure consistent 1-decimal rounding
        state.cellTransforms[cellIndex] = { ...current, exposure: Math.round(exposure * 10) / 10 };
      }),
    );
  }

  function resetActiveImageView(): void {
    const cellIndex = uiState.activeCellIndex;
    setUIState(
      produce((state) => {
        state.cellTransforms[cellIndex] = { ...DEFAULT_CELL_TRANSFORM };
      }),
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
