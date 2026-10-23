import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationContext, CountScope } from './types.js';

/**
 * Returns `true` if the context applies to the given image.
 * - `imageIds` undefined → applies to all images
 * - `imageIds` empty `[]` → applies to no images (context effectively disabled)
 * - `imageIds` contains `imageId` → applies
 */
export function isContextScopedToImage(context: AnnotationContext, imageId: ImageId): boolean {
  if (context.imageIds === undefined) return true;
  return context.imageIds.includes(imageId);
}

/**
 * Returns which image IDs should be counted for constraint checking.
 * - `'per-image'` → only count annotations on the current image
 * - `'global'` → count across all scoped images (undefined = all images)
 */
export function getCountableImageIds(
  context: AnnotationContext,
  currentImageId: ImageId,
  countScope: CountScope,
): readonly ImageId[] | undefined {
  // 'per-frame' narrows further by frame; the image set is the current image.
  if (countScope === 'per-image' || countScope === 'per-frame') return [currentImageId];
  // 'global': if context has imageIds, count only those; otherwise undefined = all
  return context.imageIds;
}
