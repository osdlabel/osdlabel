import type { Annotation, AnnotationId } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { Decoration } from './decoration.js';

/**
 * Inputs to a `DecorationProvider`. Generic over the annotation extension
 * type so providers can read extension fields (e.g. `contextId`, `imageId`)
 * from the annotations they receive.
 */
export interface DecorationContext<E extends object = Record<never, never>> {
  /** All annotations currently visible in the cell the decorations are being computed for. */
  readonly annotations: readonly Annotation<E>[];
  /** Calibration for the cell's image; `undefined` if no calibration is set. */
  readonly pixelSpacing?: PixelSpacing | undefined;
  /** The currently selected annotation ID, if any. Used for selection emphasis. */
  readonly selectedAnnotationId: AnnotationId | null;
}

/**
 * A pure function that derives decorations from current annotation state.
 *
 * Providers run on every reactive recomputation — they must be deterministic
 * and side-effect-free. The renderer diffs the returned array by
 * `Decoration.id`, so providers should produce stable ids.
 */
export type DecorationProvider<E extends object = Record<never, never>> = (
  ctx: DecorationContext<E>,
) => readonly Decoration[];

/**
 * Compose multiple providers into a single provider that emits the union of
 * their outputs. Pure flat-map; ordering is preserved.
 */
export function composeProviders<E extends object = Record<never, never>>(
  providers: readonly DecorationProvider<E>[],
): DecorationProvider<E> {
  return (ctx) => providers.flatMap((p) => p(ctx));
}
