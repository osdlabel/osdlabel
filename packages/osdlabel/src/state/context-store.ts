import { createStore } from 'solid-js/store';
import { createMemo } from 'solid-js';
import type { ToolType, ImageId } from '@osdlabel/annotation';
import type { AnnotationState } from '@osdlabel/viewer-api';
import type {
  AnnotationContextId,
  ContextState,
  ConstraintStatus,
} from '@osdlabel/annotation-context';
import { isContextScopedToImage, getCountableImageIds } from '@osdlabel/annotation-context';
import type { OsdFields } from '../types.js';

export function createContextStore() {
  const [state, setState] = createStore<ContextState>({
    contexts: [],
    activeContextId: null,
    displayedContextIds: [],
  });
  return { state, setState };
}

export function createConstraintStatus(
  contextState: ContextState,
  annotationState: AnnotationState<OsdFields>,
  currentImageId: () => ImageId | undefined,
) {
  return createMemo<ConstraintStatus>(() => {
    const activeContext = contextState.contexts.find((c) => c.id === contextState.activeContextId);
    const imgId = currentImageId();

    const allTypes: ToolType[] = [
      'rectangle',
      'circle',
      'line',
      'point',
      'polyline',
      'freeHandPath',
    ];
    const result: Partial<ConstraintStatus> = {};

    if (!activeContext || !imgId || !isContextScopedToImage(activeContext, imgId)) {
      for (const type of allTypes) {
        result[type] = { enabled: false, currentCount: 0, maxCount: null };
      }
      return result as ConstraintStatus;
    }

    for (const type of allTypes) {
      const toolConstraint = activeContext.tools.find((t) => t.type === type);
      if (!toolConstraint) {
        result[type] = { enabled: false, currentCount: 0, maxCount: null };
      } else {
        const countScope = toolConstraint.countScope ?? 'global';
        const currentCount = countAnnotationsForContextAndType(
          annotationState,
          activeContext.id,
          type,
          getCountableImageIds(activeContext, imgId, countScope),
        );
        const maxCount = toolConstraint.maxCount ?? null;
        const enabled = maxCount === null || currentCount < maxCount;

        result[type] = {
          enabled,
          currentCount,
          maxCount,
        };
      }
    }
    return result as ConstraintStatus;
  });
}

function countAnnotationsForContextAndType(
  annotationState: AnnotationState<OsdFields>,
  contextId: AnnotationContextId,
  type: ToolType,
  scopedImageIds?: readonly ImageId[] | undefined,
): number {
  let count = 0;
  const imageBuckets = scopedImageIds
    ? scopedImageIds.map((id) => annotationState.byImage[id])
    : Object.values(annotationState.byImage);

  for (const imageAnns of imageBuckets) {
    if (!imageAnns) continue;
    for (const ann of Object.values(imageAnns)) {
      if (ann.contextId === contextId && ann.toolType === type) {
        count++;
      }
    }
  }

  return count;
}
