import { describe, it, expect, vi } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import type { AnnotationContext } from '@osdlabel/annotation-context';
import {
  createInitialAnnotationState,
  createInitialContextState,
  createInitialUIState,
} from 'osdlabel';
import {
  createAnnotatorStore,
  selectActiveImageId,
  type AnnotatorStore,
} from '../../../src/state/annotator-store.js';
import { contextId, imageId, rect } from '../fixtures.js';

/**
 * The store `AnnotatorProvider` keeps its state in (#217), tested on its own.
 *
 * React only, with no Solid counterpart: Solid's state already lives in
 * `createStore`, which applies each write synchronously. This store exists to
 * give React the same — a write visible to the next read before any render —
 * while staying a valid `useSyncExternalStore` source: a snapshot whose
 * identity changes exactly when the state does, and a constraint-status
 * selector that keeps its identity across writes that do not affect it.
 */
describe('createAnnotatorStore', () => {
  function createStore(): AnnotatorStore {
    return createAnnotatorStore({
      annotationState: createInitialAnnotationState(),
      uiState: createInitialUIState(),
      contextState: createInitialContextState(),
    });
  }

  const context: AnnotationContext = {
    id: contextId,
    label: 'One rectangle',
    tools: [{ type: 'rectangle', maxCount: 1 }],
  };

  it('applies a write before returning, so the next read sees it', () => {
    const store = createStore();
    store.dispatchAnnotation({ type: 'ADD_ANNOTATION', payload: rect('r1') });
    expect(
      store.getSnapshot().annotationState.byImage[imageId]?.[createAnnotationId('r1')],
    ).toBeDefined();
  });

  it('notifies once per write that changes the state, and not for a no-op', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: 'rectangle' });
    expect(listener).toHaveBeenCalledTimes(1);

    const before = store.getSnapshot();
    // The same value again: Immer returns its input unchanged.
    store.dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: 'rectangle' });
    // An update to an annotation that does not exist changes nothing either.
    store.dispatchAnnotation({
      type: 'UPDATE_ANNOTATION',
      payload: { id: createAnnotationId('missing'), imageId, patch: { label: 'x' } },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    // `useSyncExternalStore` compares snapshots with `Object.is`; a new object
    // for an unchanged state would re-render every consumer for nothing.
    expect(store.getSnapshot()).toBe(before);
  });

  it('leaves the previous snapshot untouched, and keeps the untouched slices', () => {
    const store = createStore();
    const before = store.getSnapshot();
    const beforeTool = before.uiState.activeTool;

    store.dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: 'circle' });

    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(before.uiState.activeTool).toBe(beforeTool);
    expect(after.uiState.activeTool).toBe('circle');
    expect(after.annotationState).toBe(before.annotationState);
    expect(after.contextState).toBe(before.contextState);
  });

  describe('selectConstraintStatus', () => {
    function createActiveStore(): AnnotatorStore {
      const store = createStore();
      store.dispatchUI({ type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex: 0, imageId } });
      store.dispatchContext({ type: 'SET_CONTEXTS', payload: [context] });
      store.dispatchContext({ type: 'SET_ACTIVE_CONTEXT', payload: contextId });
      return store;
    }

    it('returns the same object across a write that does not affect it', () => {
      const store = createActiveStore();
      const before = store.getConstraintStatus();

      store.dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: 'rectangle' });

      expect(store.getConstraintStatus()).toBe(before);
      expect(store.selectConstraintStatus(store.getSnapshot())).toBe(before);
    });

    it('recomputes when the annotations change', () => {
      const store = createActiveStore();
      const before = store.getConstraintStatus();
      expect(before.rectangle.enabled).toBe(true);

      store.dispatchAnnotation({ type: 'ADD_ANNOTATION', payload: rect('r1') });

      const after = store.getConstraintStatus();
      expect(after).not.toBe(before);
      expect(after.rectangle.currentCount).toBe(1);
      expect(after.rectangle.enabled).toBe(false);
    });

    it('recomputes when the contexts change', () => {
      const store = createActiveStore();
      store.dispatchAnnotation({ type: 'ADD_ANNOTATION', payload: rect('r1') });
      expect(store.getConstraintStatus().rectangle.enabled).toBe(false);

      store.dispatchContext({
        type: 'SET_CONTEXTS',
        payload: [{ ...context, tools: [{ type: 'rectangle', maxCount: 2 }] }],
      });

      expect(store.getConstraintStatus().rectangle.enabled).toBe(true);
    });

    it('recomputes when the active image changes', () => {
      const store = createActiveStore();
      store.dispatchContext({
        type: 'SET_CONTEXTS',
        payload: [
          { ...context, tools: [{ type: 'rectangle', maxCount: 1, countScope: 'per-image' }] },
        ],
      });
      store.dispatchAnnotation({ type: 'ADD_ANNOTATION', payload: rect('r1') });
      expect(store.getConstraintStatus().rectangle.enabled).toBe(false);

      store.dispatchUI({
        type: 'ASSIGN_IMAGE_TO_CELL',
        payload: { cellIndex: 0, imageId: createImageId('img2') },
      });

      expect(store.getConstraintStatus().rectangle.enabled).toBe(true);
    });
  });

  it('stops notifying a listener once it unsubscribes', () => {
    const store = createStore();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribe(kept);
    const unsubscribe = store.subscribe(dropped);

    store.dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: 'rectangle' });
    unsubscribe();
    store.dispatchUI({ type: 'SET_ACTIVE_TOOL', payload: 'circle' });

    expect(kept).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('selectActiveImageId reads the active cell’s assignment', () => {
    const ui = createInitialUIState();
    expect(selectActiveImageId(ui)).toBeUndefined();
    expect(
      selectActiveImageId({
        gridAssignments: { 0: imageId, 1: createImageId('b') },
        activeCellIndex: 1,
      }),
    ).toBe(createImageId('b'));
  });
});
