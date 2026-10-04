import { describe, it, expect } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import {
  createInitialAnnotationState,
  createInitialContextState,
  createInitialUIState,
} from 'osdlabel';
import { annotationReducer, contextReducer, uiReducer } from '../../../src/state/reducer.js';
import { contextId, rect } from '../fixtures.js';

/**
 * The React counterpart of Solid's `ui-store.test.ts`. Solid's store is a
 * proxy that tracks per-property reads; React's is a plain object replaced by
 * an Immer `produce` per action. Two properties of that replacement are load
 * bearing and covered here: the previous state is never mutated (the
 * provider's store drops a write that returns the same reference, and a
 * snapshot React has rendered must stay what it was), and untouched sub-trees
 * keep their identity (every granular
 * `useMemo` / `useEffect` dependency in the binding relies on it — CLAUDE.md,
 * "Memo / effect deps must be as granular as Immer's structural sharing
 * allows").
 */
describe('UI reducer', () => {
  it('starts from the shared initial UI state', () => {
    const state = createInitialUIState();
    expect(state.activeTool).toBeNull();
    expect(state.activeCellIndex).toBe(0);
    expect(state.gridColumns).toBe(1);
    expect(state.gridRows).toBe(1);
    expect(state.gridAssignments).toEqual({});
    expect(state.selectedAnnotationId).toBeNull();
  });

  it('applies updates through actions', () => {
    let state = createInitialUIState();
    state = uiReducer(state, { type: 'SET_ACTIVE_TOOL', payload: 'rectangle' });
    expect(state.activeTool).toBe('rectangle');

    state = uiReducer(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 3, rows: 4 } });
    expect(state.gridColumns).toBe(3);
    expect(state.gridRows).toBe(4);

    state = uiReducer(state, { type: 'SET_ACTIVE_CELL', payload: 2 });
    expect(state.activeCellIndex).toBe(2);

    const annotationId = createAnnotationId('test-id');
    state = uiReducer(state, { type: 'SET_SELECTED_ANNOTATION', payload: annotationId });
    expect(state.selectedAnnotationId).toBe(annotationId);
  });

  it('returns a new object and leaves the previous state untouched', () => {
    const before = createInitialUIState();
    const after = uiReducer(before, { type: 'SET_ACTIVE_TOOL', payload: 'circle' });

    expect(after).not.toBe(before);
    expect(before.activeTool).toBeNull();
    expect(after.activeTool).toBe('circle');
  });

  it('keeps untouched sub-trees referentially stable', () => {
    let state = createInitialUIState();
    state = uiReducer(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: createImageId('img1') },
    });
    const assignments = state.gridAssignments;
    const transforms = state.cellTransforms;

    // A tool change touches neither; ViewerCell and the provider's
    // `activeImageId` memo depend on these references directly.
    const next = uiReducer(state, { type: 'SET_ACTIVE_TOOL', payload: 'line' });

    expect(next.gridAssignments).toBe(assignments);
    expect(next.cellTransforms).toBe(transforms);
  });
});

describe('Annotation reducer', () => {
  it('keeps another image’s bucket referentially stable', () => {
    // ViewerCell depends on `annotationState.byImage[imageId]`, so drawing in
    // one cell must not refire another cell's annotation rebuild.
    const img2 = createImageId('img2');
    let state = createInitialAnnotationState();
    state = annotationReducer(state, { type: 'ADD_ANNOTATION', payload: rect('a1') });
    state = annotationReducer(state, {
      type: 'ADD_ANNOTATION',
      payload: rect('b1', { imageId: img2 }),
    });
    const bucket2 = state.byImage[img2];
    expect(bucket2).toBeDefined();

    const next = annotationReducer(state, { type: 'ADD_ANNOTATION', payload: rect('a2') });

    expect(next.byImage[img2]).toBe(bucket2);
    expect(next.byImage).not.toBe(state.byImage);
    expect(next.changeCounter).toBe(state.changeCounter + 1);
  });

  it('leaves the previous state untouched', () => {
    const before = createInitialAnnotationState();
    const after = annotationReducer(before, { type: 'ADD_ANNOTATION', payload: rect('a1') });

    expect(before.byImage).toEqual({});
    expect(before.changeCounter).toBe(0);
    expect(after.changeCounter).toBe(1);
  });
});

describe('Context reducer', () => {
  it('keeps `contexts` stable when only the active context changes', () => {
    // useKeyboard depends on `contextState.contexts` rather than the whole
    // context state, which only helps if the array survives unrelated updates.
    let state = createInitialContextState();
    state = contextReducer(state, {
      type: 'SET_CONTEXTS',
      payload: [{ id: contextId, label: 'Ctx', tools: [] }],
    });
    const contexts = state.contexts;

    const next = contextReducer(state, { type: 'SET_ACTIVE_CONTEXT', payload: contextId });

    expect(next.activeContextId).toBe(contextId);
    expect(next.contexts).toBe(contexts);
    expect(state.activeContextId).toBeNull();
  });
});
