import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationContext, AnnotationContextId } from '@osdlabel/annotation-context';
import { isContextScopedToImage } from '@osdlabel/annotation-context';

/** Direction to step through the context ring. */
export type ContextCycleDirection = 'next' | 'previous';

/**
 * The contexts a user can actually activate for the given image, in configured
 * order. A context scoped to other images is skipped — activating it would make
 * every tool unusable on the current image.
 *
 * When `activeImageId` is undefined (no image in the active cell) no scoping
 * information is available, so every context is considered selectable.
 */
export function getSelectableContexts(
  contexts: readonly AnnotationContext[],
  activeImageId: ImageId | undefined,
): readonly AnnotationContext[] {
  if (activeImageId === undefined) return contexts;
  return contexts.filter((context) => isContextScopedToImage(context, activeImageId));
}

/**
 * Returns the context id one step away from `activeContextId`, wrapping around
 * at both ends. Returns `null` when there is nothing to cycle to.
 *
 * If the active context is unset — or is scoped out of the current image, and
 * so absent from the selectable ring — the ring is entered at the end the
 * direction implies: `'next'` lands on the first context, `'previous'` on the
 * last.
 */
export function getCycledContextId(
  contexts: readonly AnnotationContext[],
  activeContextId: AnnotationContextId | null,
  direction: ContextCycleDirection,
  activeImageId: ImageId | undefined,
): AnnotationContextId | null {
  const selectable = getSelectableContexts(contexts, activeImageId);
  if (selectable.length === 0) return null;

  const currentIndex =
    activeContextId === null ? -1 : selectable.findIndex((c) => c.id === activeContextId);

  if (currentIndex === -1) {
    const entry = direction === 'next' ? selectable[0] : selectable[selectable.length - 1];
    return entry?.id ?? null;
  }

  const delta = direction === 'next' ? 1 : -1;
  const nextIndex = (currentIndex + delta + selectable.length) % selectable.length;
  return selectable[nextIndex]?.id ?? null;
}
