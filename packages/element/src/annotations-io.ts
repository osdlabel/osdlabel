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

/**
 * Whether two flat lists hold the same annotations at the same revision:
 * same (imageId, id) pairs, each with the same `updatedAt`. Order-insensitive
 * and identity-insensitive, because the usual "controlled" host pattern hands
 * the list from `annotationschange` straight back to the `annotations`
 * property, often wrapped in the framework's reactive proxies (Vue's deep
 * `ref`, Svelte 5's `$state`), so identity says nothing.
 */
export function isSameAnnotationSet(
  a: readonly OsdAnnotation[],
  b: readonly OsdAnnotation[],
): boolean {
  if (a.length !== b.length) return false;
  const revisions = new Map<string, string>();
  for (const x of a) revisions.set(`${x.imageId}\u0000${x.id}`, x.updatedAt);
  if (revisions.size !== a.length) return false;
  for (const y of b) {
    if (revisions.get(`${y.imageId}\u0000${y.id}`) !== y.updatedAt) return false;
  }
  return true;
}
