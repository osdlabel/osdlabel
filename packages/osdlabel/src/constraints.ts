import type { ToolType } from '@osdlabel/annotation';
import type { ImageId, AnnotationState } from '@osdlabel/viewer-api';
import type {
  AnnotationContextId,
  ContextState,
  ConstraintStatus,
} from '@osdlabel/annotation-context';
import { isContextScopedToImage, getCountableImageIds } from '@osdlabel/annotation-context';
import type { OsdFields } from './types.js';

const ALL_TOOL_TYPES: readonly ToolType[] = [
  'rectangle',
  'circle',
  'line',
  'point',
  'polyline',
  'freeHandPath',
  'segmentation',
] as const;

/**
 * Pure function that computes constraint status from current state.
 * Framework wrappers memoize this (createMemo in Solid, useMemo in React).
 */
export function computeConstraintStatus(
  contextState: ContextState,
  annotationState: AnnotationState<OsdFields>,
  currentImageId: ImageId | undefined,
): ConstraintStatus {
  const activeContext = contextState.contexts.find((c) => c.id === contextState.activeContextId);

  const result: Partial<ConstraintStatus> = {};

  if (!activeContext || !currentImageId || !isContextScopedToImage(activeContext, currentImageId)) {
    for (const type of ALL_TOOL_TYPES) {
      result[type] = { enabled: false, currentCount: 0, maxCount: null };
    }
    return result as ConstraintStatus;
  }

  for (const type of ALL_TOOL_TYPES) {
    const toolConstraint = activeContext.tools.find((t) => t.type === type);
    if (!toolConstraint) {
      result[type] = { enabled: false, currentCount: 0, maxCount: null };
    } else {
      const countScope = toolConstraint.countScope ?? 'global';
      const currentCount = countAnnotationsForContextAndType(
        annotationState,
        activeContext.id,
        type,
        getCountableImageIds(activeContext, currentImageId, countScope),
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
}

export function countAnnotationsForContextAndType(
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
