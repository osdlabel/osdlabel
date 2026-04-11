import { createStore } from 'solid-js/store';
import type { AnnotationState } from '@osdlabel/viewer-api';
import type { OsdFields } from 'osdlabel';
import { createInitialAnnotationState } from 'osdlabel';

export function createAnnotationStore() {
  const [state, setState] = createStore<AnnotationState<OsdFields>>(createInitialAnnotationState());
  return { state, setState };
}
