import { produce } from 'immer';
import type { AnnotationState, UIState } from '@osdlabel/viewer-api';
import type { ContextState } from '@osdlabel/annotation-context';
import type { OsdFields } from 'osdlabel';
import { applyAnnotationAction, applyUIAction, applyContextAction } from 'osdlabel';
import type { AnnotationAction, UIAction, ContextAction } from 'osdlabel';

export function annotationReducer(
  state: AnnotationState<OsdFields>,
  action: AnnotationAction,
): AnnotationState<OsdFields> {
  return produce(state, (draft) => applyAnnotationAction(draft, action));
}

export function uiReducer(state: UIState, action: UIAction): UIState {
  return produce(state, (draft) => applyUIAction(draft, action));
}

export function contextReducer(state: ContextState, action: ContextAction): ContextState {
  return produce(state, (draft) => applyContextAction(draft, action));
}
