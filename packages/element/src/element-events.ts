import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { ConstraintStatus } from '@osdlabel/annotation-context';
import type { OsdAnnotation } from 'osdlabel';

/**
 * DOM event names `<osdlabel-annotator>` dispatches on itself.
 *
 * All lowercase and dash-free, because that is the one spelling every host
 * framework binds without configuration: Vue's `@annotationschange`, Svelte 5's
 * `onannotationschange`, Angular's `(annotationschange)`, React 19's
 * `onannotationschange` and plain `addEventListener` all reach it.
 *
 * Deliberately NOT `selectionchange`: that is a native `GlobalEventHandlers`
 * event which Chromium fires (bubbling) at `<input>` / `<textarea>` while the
 * user moves a caret, so a host listening for it on the element would also
 * receive caret moves from any text field inside it.
 */
export const ANNOTATOR_EVENTS = {
  annotationsChange: 'annotationschange',
  selectedAnnotationChange: 'selectedannotationchange',
  activeToolChange: 'activetoolchange',
  constraintChange: 'constraintchange',
  ready: 'osdlabelready',
} as const;

export type AnnotatorEventName = (typeof ANNOTATOR_EVENTS)[keyof typeof ANNOTATOR_EVENTS];

export interface AnnotationsChangeDetail {
  readonly annotations: readonly OsdAnnotation[];
}

export interface SelectedAnnotationChangeDetail {
  readonly annotationId: AnnotationId | null;
}

export interface ActiveToolChangeDetail {
  readonly tool: ToolType | 'select' | null;
}

export interface ConstraintChangeDetail {
  readonly status: ConstraintStatus;
}

export interface ReadyDetail {
  /** `performance.now()` when the Solid tree finished its first synchronous render. */
  readonly renderedAt: number;
}

/** Detail type for each event, keyed by event name. */
export interface AnnotatorEventDetailMap {
  annotationschange: AnnotationsChangeDetail;
  selectedannotationchange: SelectedAnnotationChangeDetail;
  activetoolchange: ActiveToolChangeDetail;
  constraintchange: ConstraintChangeDetail;
  osdlabelready: ReadyDetail;
}

/** `addEventListener` typing for hosts written in TypeScript. */
export type AnnotatorEventMap = {
  readonly [K in AnnotatorEventName]: CustomEvent<AnnotatorEventDetailMap[K]>;
};

/**
 * Builds one of the element's events. Bubbles so a host can delegate from an
 * ancestor; not composed, because it is dispatched on the host element, which
 * is already outside the shadow root.
 */
export function createAnnotatorEvent<K extends AnnotatorEventName>(
  name: K,
  detail: AnnotatorEventDetailMap[K],
): CustomEvent<AnnotatorEventDetailMap[K]> {
  return new CustomEvent(name, { detail, bubbles: true, composed: false });
}
