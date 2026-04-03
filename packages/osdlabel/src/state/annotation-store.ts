import { createStore } from 'solid-js/store';
import type { AnnotationState } from '@osdlabel/viewer-api';
import type { OsdFields } from '../types.js';

export function createAnnotationStore() {
  const [state, setState] = createStore<AnnotationState<OsdFields>>({
    byImage: {},
    changeCounter: 0,
  });
  return { state, setState };
}
