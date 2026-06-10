import type { AnnotationState, UIState } from '@osdlabel/viewer-api';
import type { ContextState } from '@osdlabel/annotation-context';
import type { OsdFields } from './types.js';

export function createInitialAnnotationState(): AnnotationState<OsdFields> {
  return {
    byImage: {},
    changeCounter: 0,
  };
}

export function createInitialUIState(): UIState {
  return {
    activeTool: null,
    activeViewerControl: null,
    activeCellIndex: 0,
    gridColumns: 1,
    gridRows: 1,
    gridAssignments: {},
    selectedAnnotationId: null,
    cellTransforms: {},
  };
}

export function createInitialContextState(): ContextState {
  return {
    contexts: [],
    activeContextId: null,
    displayedContextIds: [],
  };
}
