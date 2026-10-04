import type { Dispatch } from 'react';
import type { AnnotationState, ImageId, UIState } from '@osdlabel/viewer-api';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import type { AnnotationAction, ContextAction, OsdFields, UIAction } from 'osdlabel';
import { computeConstraintStatus } from 'osdlabel';
import { annotationReducer, contextReducer, uiReducer } from './reducer.js';

/**
 * The three state slices, as one immutable value. A write that changes a slice
 * produces a new snapshot holding the new slice and the other two unchanged by
 * identity; a write that changes nothing leaves the snapshot as it was.
 */
export interface AnnotatorSnapshot {
  readonly annotationState: AnnotationState<OsdFields>;
  readonly uiState: UIState;
  readonly contextState: ContextState;
}

/**
 * The read side of the annotator store, as `useAnnotator().store` exposes it.
 *
 * The store is what makes React's actions behave like Solid's within one
 * batch (#217). Every write is applied to it synchronously, so
 * {@link AnnotatorStoreReader.getSnapshot} already reflects a write that the
 * component tree has not rendered yet. `useAnnotator()`'s `annotationState`,
 * `uiState`, `contextState` and `constraintStatus` are the last *rendered*
 * values; read the store instead from code that runs outside render (an event
 * handler, a long-lived Fabric listener) and must see writes made earlier in
 * the same handler.
 */
export interface AnnotatorStoreReader {
  /**
   * The latest state, every write so far applied. Keeps its identity until a
   * write changes something, as `useSyncExternalStore` requires.
   */
  getSnapshot(): AnnotatorSnapshot;
  /** Calls `listener` after every write that changes the snapshot. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The constraint status as of the latest write. */
  getConstraintStatus(): ConstraintStatus;
}

/**
 * The store itself, internal to `AnnotatorProvider`: the reader plus the
 * memoised selector render uses and the three dispatchers `createActions`
 * takes. Not exported from the package; hosts get the reader.
 */
export interface AnnotatorStore extends AnnotatorStoreReader {
  /**
   * The constraint status of `snapshot`, memoised on the identities of its
   * context state and annotation state and on its active image id. An update
   * that touches none of those returns the previous status object. The cache
   * holds one entry, shared with `getConstraintStatus`; only the provider
   * calls this, always with the latest snapshot, so the two never evict each
   * other. A caller passing an older snapshot would, which is why it is not on
   * the reader.
   */
  selectConstraintStatus(snapshot: AnnotatorSnapshot): ConstraintStatus;
  readonly dispatchAnnotation: Dispatch<AnnotationAction>;
  readonly dispatchUI: Dispatch<UIAction>;
  readonly dispatchContext: Dispatch<ContextAction>;
}

/** The image in the active grid cell, if any. */
export function selectActiveImageId(
  uiState: Pick<UIState, 'gridAssignments' | 'activeCellIndex'>,
): ImageId | undefined {
  return uiState.gridAssignments[uiState.activeCellIndex];
}

/**
 * Creates the store `AnnotatorProvider` keeps its state in.
 *
 * Each dispatch runs the slice's Immer reducer (`annotationReducer`,
 * `uiReducer`, `contextReducer`) against the latest snapshot immediately,
 * rather than at the next render as `useReducer` would. The provider reads it
 * through `useSyncExternalStore`.
 */
export function createAnnotatorStore(initial: AnnotatorSnapshot): AnnotatorStore {
  let snapshot: AnnotatorSnapshot = initial;
  const listeners = new Set<() => void>();

  function commit<K extends keyof AnnotatorSnapshot>(key: K, next: AnnotatorSnapshot[K]): void {
    // An Immer no-op returns its input, so an action that changes nothing
    // neither replaces the snapshot nor re-renders anything.
    if (Object.is(next, snapshot[key])) return;
    snapshot = { ...snapshot, [key]: next };
    // A copy, so a listener that unsubscribes (or subscribes) mid-notify does
    // not disturb the iteration.
    for (const listener of [...listeners]) listener();
  }

  let cachedContextState: ContextState | undefined;
  let cachedAnnotationState: AnnotationState<OsdFields> | undefined;
  let cachedActiveImageId: ImageId | undefined;
  let cachedStatus: ConstraintStatus | undefined;

  function selectConstraintStatus(s: AnnotatorSnapshot): ConstraintStatus {
    const activeImageId = selectActiveImageId(s.uiState);
    if (
      cachedStatus !== undefined &&
      cachedContextState === s.contextState &&
      cachedAnnotationState === s.annotationState &&
      cachedActiveImageId === activeImageId
    ) {
      return cachedStatus;
    }
    const status = computeConstraintStatus(s.contextState, s.annotationState, activeImageId);
    cachedContextState = s.contextState;
    cachedAnnotationState = s.annotationState;
    cachedActiveImageId = activeImageId;
    cachedStatus = status;
    return status;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selectConstraintStatus,
    getConstraintStatus: () => selectConstraintStatus(snapshot),
    dispatchAnnotation: (action) =>
      commit('annotationState', annotationReducer(snapshot.annotationState, action)),
    dispatchUI: (action) => commit('uiState', uiReducer(snapshot.uiState, action)),
    dispatchContext: (action) =>
      commit('contextState', contextReducer(snapshot.contextState, action)),
  };
}
