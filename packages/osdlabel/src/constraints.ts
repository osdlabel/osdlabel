import type { AnnotationId, ToolType } from '@osdlabel/annotation';
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
  'segmentationBrush',
] as const;

/**
 * Pure function that computes constraint status from current state.
 * Framework wrappers memoize this (createMemo in Solid, useMemo in React).
 *
 * `enabled` means the tool can do something now. For every vector tool that
 * is "may add an annotation": the count is under the limit. The brush also
 * edits in place, so it stays enabled at its limit while a mask it can refine
 * is selected — one of the active context's masks on the current image —
 * which is why the selection is an input here. Whether a tool may *add* is
 * {@link canAddAnnotation}; reading `enabled` for that lets the brush start a
 * new mask past its limit.
 */
export function computeConstraintStatus(
  contextState: ContextState,
  annotationState: AnnotationState<OsdFields>,
  currentImageId: ImageId | undefined,
  selectedAnnotationId: AnnotationId | null = null,
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
      const underLimit = maxCount === null || currentCount < maxCount;
      const enabled =
        underLimit ||
        (type === 'segmentationBrush' &&
          canRefineSelectedMask(
            annotationState,
            currentImageId,
            activeContext.id,
            selectedAnnotationId,
          ));

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

/** Whether the selection is a mask the brush may refine: on this image, in the active context. */
function canRefineSelectedMask(
  annotationState: AnnotationState<OsdFields>,
  currentImageId: ImageId,
  activeContextId: AnnotationContextId,
  selectedAnnotationId: AnnotationId | null,
): boolean {
  if (selectedAnnotationId === null) return false;
  const selected = annotationState.byImage[currentImageId]?.[selectedAnnotationId];
  return (
    selected !== undefined &&
    selected.geometry.type === 'mask' &&
    selected.contextId === activeContextId
  );
}

/**
 * Whether `type` may add an annotation now: enabled, and under its limit.
 *
 * Distinct from `enabled` for the brush, which stays usable at its limit to
 * refine the selected mask but may not start another; see
 * {@link computeConstraintStatus}.
 */
export function canAddAnnotation(status: ConstraintStatus, type: ToolType): boolean {
  const s = status[type];
  return s.enabled && (s.maxCount === null || s.currentCount < s.maxCount);
}
