import type { OsdAnnotation } from './types.js';

/**
 * An annotation that could not be turned back into a canvas object, so it was
 * left off the canvas. It stays in state, and every other annotation on the
 * image still renders.
 *
 * Typically the stored `rawAnnotationData` cannot be revived: it is malformed,
 * or names a Fabric class that is not registered (data written by a newer
 * version, or a custom shape).
 *
 * A plain record, not an `Error`: `error` holds what was thrown.
 */
export interface AnnotationRenderFailure<A = OsdAnnotation> {
  /** The annotation that was skipped. */
  readonly annotation: A;
  /** What building its object threw or rejected with. */
  readonly error: unknown;
}

/** What {@link settleAnnotationObjects} built, and what it had to skip. */
export interface SettledAnnotationObjects<A, T> {
  /** The objects that were built, in the annotations' order. */
  readonly objects: readonly T[];
  /** One entry per annotation whose build threw or rejected. */
  readonly failures: readonly AnnotationRenderFailure<A>[];
}

/**
 * Builds an object for every annotation, independently: one that fails is
 * reported and skipped instead of failing the rest. A build that resolves to
 * `null` (nothing to draw) is skipped without being a failure.
 *
 * Shared by the SolidJS and React `ViewerCell`, which previously awaited
 * `Promise.all`, so a single unrevivable annotation left the whole image's
 * canvas empty (#209).
 */
export async function settleAnnotationObjects<A, T>(
  annotations: readonly A[],
  build: (annotation: A) => Promise<T | null>,
): Promise<SettledAnnotationObjects<A, T>> {
  const results = await Promise.allSettled(annotations.map((annotation) => build(annotation)));
  const objects: T[] = [];
  const failures: AnnotationRenderFailure<A>[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value !== null) objects.push(result.value);
    } else {
      failures.push({ annotation: annotations[index]!, error: result.reason });
    }
  });
  return { objects, failures };
}

/**
 * The default for an annotator with no `onAnnotationRenderError`: a warning
 * naming the annotation, so a skipped annotation is never silent.
 */
export function warnAnnotationRenderError(failure: AnnotationRenderFailure): void {
  console.warn(
    `osdlabel: annotation "${failure.annotation.id}" on image "${failure.annotation.imageId}" could not be rendered and was skipped.`,
    failure.error,
  );
}

/**
 * Hands each failure to `report`, one at a time. A `report` that throws (a
 * host's `onAnnotationRenderError`) is logged with `console.error` and does not
 * stop the remaining failures from being reported, nor surface as an
 * unhandled rejection from the rebuild that called it.
 */
export function reportAnnotationRenderFailures(
  failures: readonly AnnotationRenderFailure[],
  report: (failure: AnnotationRenderFailure) => void,
): void {
  for (const failure of failures) {
    try {
      report(failure);
    } catch (handlerError) {
      console.error(
        `osdlabel: onAnnotationRenderError threw while reporting annotation "${failure.annotation.id}".`,
        handlerError,
      );
    }
  }
}
