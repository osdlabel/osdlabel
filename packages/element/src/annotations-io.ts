import type { AnnotationId } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { OsdAnnotation } from 'osdlabel';

/** The provider's `initialAnnotations` / `loadAnnotations` shape. */
export type AnnotationsByImage = Record<ImageId, Record<AnnotationId, OsdAnnotation>>;

/**
 * Groups the flat list the element exposes on `annotations` (the same shape
 * `annotationschange` carries) into the per-image dictionary the store holds,
 * so the property reads back what was written to it.
 *
 * A later entry with the same id on the same image replaces an earlier one,
 * as a second `ADD_ANNOTATION` would.
 */
export function groupAnnotationsByImage(list: readonly OsdAnnotation[]): AnnotationsByImage {
  const byImage: AnnotationsByImage = {};
  for (const annotation of list) {
    const bucket = (byImage[annotation.imageId] ??= {});
    bucket[annotation.id] = annotation;
  }
  return byImage;
}
