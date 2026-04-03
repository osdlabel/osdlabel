import type { AnnotationState, ImageId } from './types.js';
import type { AnnotationId } from './annotation.js';
import type { Annotation } from './annotation.js';
import { createImageId } from './util.js';

/** Error type for serialization/deserialization failures */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/** Result of deserializing an annotation document */
export interface DeserializeResult<E extends object = Record<string, never>> {
  readonly byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>>;
}

/**
 * Serialize annotation state into a portable flat array of annotations.
 */
export function serialize<E extends object = Record<string, never>>(
  state: AnnotationState<E>,
): Annotation<E>[] {
  return getAllAnnotationsFlat(state);
}

/**
 * Deserialize a flat array of annotations back into the byImage store structure.
 * Validates basic array structure but relies on external schemas (e.g. Valibot)
 * for deep annotation validation.
 */
export function deserialize<E extends object = Record<string, never>>(
  doc: unknown,
): DeserializeResult<E> {
  if (!Array.isArray(doc)) {
    throw new SerializationError('Document must be an array of annotations');
  }

  const byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>> = {};

  for (const rawAnn of doc) {
    if (typeof rawAnn !== 'object' || rawAnn === null) {
      throw new SerializationError('Each annotation must be an object');
    }

    const entry = rawAnn as Record<string, unknown>;

    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new SerializationError('Annotation missing valid id');
    }

    if (typeof entry.imageId !== 'string' || entry.imageId === '') {
      throw new SerializationError(`Annotation ${entry.id} missing valid imageId`);
    }

    const imageId = createImageId(entry.imageId);

    if (!byImage[imageId]) {
      byImage[imageId] = {};
    }

    byImage[imageId][entry.id as AnnotationId] = rawAnn as Annotation<E>;
  }

  return { byImage };
}

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
      result.push(...Object.values(annMap));
    }
  }
  return result;
}
