import type { Annotation, ImageId } from '@osdlabel/annotation';
import type { AnnotationState } from './types.js';

/**
 * Flatten all annotations from the store into a single array.
 */
export function getAllAnnotationsFlat<E extends object = Record<string, never>>(
  state: AnnotationState<E>,
): Annotation<E>[] {
  const result: Annotation<E>[] = [];
  for (const imageId of Object.keys(state.byImage)) {
    const annMap = state.byImage[imageId as ImageId];
    if (annMap) {
      result.push(...Object.values(annMap) as Annotation<E>[]);
    }
  }
  return result;
}
