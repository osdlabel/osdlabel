import { createStore } from 'solid-js/store';
import { createMemo } from 'solid-js';
import type { AnnotationId } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import type { ContextState, ConstraintStatus } from '@osdlabel/annotation-context';
import type { OsdFields } from 'osdlabel';
import { createInitialContextState, computeConstraintStatus } from 'osdlabel';

export function createContextStore() {
  const [state, setState] = createStore<ContextState>(createInitialContextState());
  return { state, setState };
}

export function createConstraintStatus(
  contextState: ContextState,
  annotationState: AnnotationState<OsdFields>,
  currentImageId: () => ImageId | undefined,
  /** The brush stays enabled at its limit while a mask it can refine is selected. */
  selectedAnnotationId: () => AnnotationId | null = () => null,
) {
  return createMemo<ConstraintStatus>(() =>
    computeConstraintStatus(
      contextState,
      annotationState,
      currentImageId(),
      selectedAnnotationId(),
    ),
  );
}
