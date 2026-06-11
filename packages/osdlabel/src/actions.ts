import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { AnnotationState, ImageId, UIState, ViewerControlId } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import type {
  AnnotationContext,
  AnnotationContextId,
  ContextState,
} from '@osdlabel/annotation-context';
import { isContextScopedToImage } from '@osdlabel/annotation-context';
import type { OsdAnnotation, OsdFields } from './types.js';

// ---------------------------------------------------------------------------
// Action type discriminated unions
// ---------------------------------------------------------------------------

export type AnnotationAction =
  | {
      readonly type: 'ADD_ANNOTATION';
      readonly payload: Omit<OsdAnnotation, 'createdAt' | 'updatedAt'>;
    }
  | {
      readonly type: 'UPDATE_ANNOTATION';
      readonly payload: {
        readonly id: AnnotationId;
        readonly imageId: ImageId;
        readonly patch: Partial<Omit<OsdAnnotation, 'id' | 'imageId' | 'createdAt' | 'updatedAt'>>;
      };
    }
  | {
      readonly type: 'DELETE_ANNOTATION';
      readonly payload: { readonly id: AnnotationId; readonly imageId: ImageId };
    }
  | {
      readonly type: 'LOAD_ANNOTATIONS';
      readonly payload: Record<ImageId, Record<AnnotationId, OsdAnnotation>>;
    };

export type UIAction =
  | { readonly type: 'SET_ACTIVE_TOOL'; readonly payload: ToolType | 'select' | null }
  | { readonly type: 'SET_ACTIVE_VIEWER_CONTROL'; readonly payload: ViewerControlId | null }
  | { readonly type: 'SET_ACTIVE_CELL'; readonly payload: number }
  | { readonly type: 'SET_SELECTED_ANNOTATION'; readonly payload: AnnotationId | null }
  | {
      readonly type: 'ASSIGN_IMAGE_TO_CELL';
      readonly payload: { readonly cellIndex: number; readonly imageId: ImageId };
    }
  | {
      readonly type: 'SET_GRID_DIMENSIONS';
      readonly payload: { readonly columns: number; readonly rows: number };
    }
  | { readonly type: 'ROTATE_CW'; readonly payload: { readonly cellIndex: number } }
  | { readonly type: 'ROTATE_CCW'; readonly payload: { readonly cellIndex: number } }
  | { readonly type: 'FLIP_H'; readonly payload: { readonly cellIndex: number } }
  | { readonly type: 'FLIP_V'; readonly payload: { readonly cellIndex: number } }
  | { readonly type: 'TOGGLE_NEGATIVE'; readonly payload: { readonly cellIndex: number } }
  | { readonly type: 'INCREASE_EXPOSURE'; readonly payload: { readonly cellIndex: number } }
  | { readonly type: 'DECREASE_EXPOSURE'; readonly payload: { readonly cellIndex: number } }
  | {
      readonly type: 'SET_EXPOSURE';
      readonly payload: { readonly cellIndex: number; readonly value: number };
    }
  | { readonly type: 'RESET_VIEW'; readonly payload: { readonly cellIndex: number } };

export type ContextAction =
  | { readonly type: 'SET_CONTEXTS'; readonly payload: AnnotationContext[] }
  | { readonly type: 'SET_ACTIVE_CONTEXT'; readonly payload: AnnotationContextId | null }
  | { readonly type: 'SET_DISPLAYED_CONTEXTS'; readonly payload: AnnotationContextId[] };

// ---------------------------------------------------------------------------
// Cross-store validation (must be called before ADD_ANNOTATION dispatch)
// ---------------------------------------------------------------------------

/**
 * Returns true if the annotation can be added given the current context state.
 * Both framework wrappers call this before dispatching ADD_ANNOTATION.
 */
export function validateAddAnnotation(
  annotation: Omit<OsdAnnotation, 'createdAt' | 'updatedAt'>,
  contextState: ContextState,
): boolean {
  const ctx = contextState.contexts.find((c) => c.id === annotation.contextId);
  if (ctx && !isContextScopedToImage(ctx, annotation.imageId)) {
    console.warn(`Context "${ctx.label}" not scoped to image "${annotation.imageId}"`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pure reducer functions — mutate draft in place
// Compatible with both solid-js/store produce() and immer produce()
// ---------------------------------------------------------------------------

export function applyAnnotationAction(
  draft: AnnotationState<OsdFields>,
  action: AnnotationAction,
): void {
  switch (action.type) {
    case 'ADD_ANNOTATION': {
      const annotation = action.payload;
      const imageAnns = draft.byImage[annotation.imageId] ?? {};
      const now = new Date().toISOString();
      imageAnns[annotation.id] = {
        ...annotation,
        createdAt: now,
        updatedAt: now,
      };
      draft.byImage[annotation.imageId] = imageAnns;
      draft.changeCounter += 1;
      break;
    }
    case 'UPDATE_ANNOTATION': {
      const { id, imageId, patch } = action.payload;
      const imageAnns = draft.byImage[imageId];
      if (imageAnns && imageAnns[id]) {
        imageAnns[id] = {
          ...imageAnns[id],
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        draft.changeCounter += 1;
      }
      break;
    }
    case 'DELETE_ANNOTATION': {
      const { id, imageId } = action.payload;
      const imageAnns = draft.byImage[imageId];
      if (imageAnns) {
        delete imageAnns[id];
        draft.changeCounter += 1;
      }
      break;
    }
    case 'LOAD_ANNOTATIONS': {
      draft.byImage = action.payload;
      draft.changeCounter += 1;
      break;
    }
  }
}

export function applyUIAction(draft: UIState, action: UIAction): void {
  switch (action.type) {
    case 'SET_ACTIVE_TOOL':
      draft.activeTool = action.payload;
      // One interaction owns the pointer at a time: selecting a tool exits any
      // active viewer control.
      if (action.payload !== null) {
        draft.activeViewerControl = null;
      }
      break;
    case 'SET_ACTIVE_VIEWER_CONTROL':
      draft.activeViewerControl = action.payload;
      // Activating a viewer control exits any active annotation tool.
      if (action.payload !== null) {
        draft.activeTool = null;
      }
      break;
    case 'SET_ACTIVE_CELL':
      draft.activeCellIndex = action.payload;
      break;
    case 'SET_SELECTED_ANNOTATION':
      draft.selectedAnnotationId = action.payload;
      break;
    case 'ASSIGN_IMAGE_TO_CELL': {
      const { cellIndex, imageId } = action.payload;
      draft.gridAssignments[cellIndex] = imageId;
      draft.cellTransforms[cellIndex] = { ...DEFAULT_CELL_TRANSFORM };
      break;
    }
    case 'SET_GRID_DIMENSIONS': {
      const { columns, rows } = action.payload;
      draft.gridColumns = columns;
      draft.gridRows = rows;
      const maxIndex = columns * rows - 1;
      for (const indexStr of Object.keys(draft.cellTransforms)) {
        const index = parseInt(indexStr, 10);
        if (index > maxIndex) {
          delete draft.cellTransforms[index];
        }
      }
      break;
    }
    case 'ROTATE_CW': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      draft.cellTransforms[action.payload.cellIndex] = {
        ...current,
        rotation: (current.rotation + 90) % 360,
      };
      break;
    }
    case 'ROTATE_CCW': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      draft.cellTransforms[action.payload.cellIndex] = {
        ...current,
        rotation: (current.rotation + 270) % 360,
      };
      break;
    }
    case 'FLIP_H': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      draft.cellTransforms[action.payload.cellIndex] = { ...current, flippedH: !current.flippedH };
      break;
    }
    case 'FLIP_V': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      draft.cellTransforms[action.payload.cellIndex] = { ...current, flippedV: !current.flippedV };
      break;
    }
    case 'TOGGLE_NEGATIVE': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      draft.cellTransforms[action.payload.cellIndex] = { ...current, inverted: !current.inverted };
      break;
    }
    case 'INCREASE_EXPOSURE': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      const exposure = Math.min(current.exposure + 0.1, 1);
      draft.cellTransforms[action.payload.cellIndex] = {
        ...current,
        exposure: Math.round(exposure * 10) / 10,
      };
      break;
    }
    case 'DECREASE_EXPOSURE': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      const exposure = Math.max(current.exposure - 0.1, -1);
      draft.cellTransforms[action.payload.cellIndex] = {
        ...current,
        exposure: Math.round(exposure * 10) / 10,
      };
      break;
    }
    case 'SET_EXPOSURE': {
      const current = draft.cellTransforms[action.payload.cellIndex] ?? {
        ...DEFAULT_CELL_TRANSFORM,
      };
      const exposure = Math.max(Math.min(action.payload.value, 1), -1);
      // Store faithfully — the caller (e.g. the drag control's `step`) owns the
      // resolution of change. Round only to strip floating-point noise so the
      // value stays clean for display and the `brightness()` filter.
      draft.cellTransforms[action.payload.cellIndex] = {
        ...current,
        exposure: Math.round(exposure * 1000) / 1000,
      };
      break;
    }
    case 'RESET_VIEW': {
      draft.cellTransforms[action.payload.cellIndex] = { ...DEFAULT_CELL_TRANSFORM };
      break;
    }
  }
}

export function applyContextAction(draft: ContextState, action: ContextAction): void {
  switch (action.type) {
    case 'SET_CONTEXTS':
      draft.contexts = action.payload;
      break;
    case 'SET_ACTIVE_CONTEXT':
      draft.activeContextId = action.payload;
      break;
    case 'SET_DISPLAYED_CONTEXTS':
      draft.displayedContextIds = action.payload;
      break;
  }
}
