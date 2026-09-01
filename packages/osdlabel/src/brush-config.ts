import {
  MASK_RAW_FORMAT,
  createAnnotationId,
  generateId,
  type AnnotationId,
} from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationState, ImageId } from '@osdlabel/viewer-api';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
import {
  DEFAULT_MAX_MASK_PIXELS,
  decodeCanonical,
  type MaskCapacityExceededError,
} from '@osdlabel/mask';
import type {
  BrushStrokeCommit,
  BrushTarget,
  SegmentationBrushToolConfig,
} from '@osdlabel/fabric-annotations';
import { createMaskAnnotation, maskAnnotationFields } from './create-mask-annotation.js';
import type { OsdAnnotation, OsdFields } from './types.js';

/**
 * Resizing steps proportionally, so the brush feels responsive whether it is
 * 2px or 200px across.
 */
export function nextBrushRadius(current: number, direction: 1 | -1): number {
  const step = Math.max(1, Math.round(current * 0.25));
  return Math.min(MAX_BRUSH_RADIUS, Math.max(MIN_BRUSH_RADIUS, current + step * direction));
}

/** State the brush reads while painting. */
export interface BrushConfigAccessors {
  readonly getBrushRadius: () => number;
  readonly isErasing: () => boolean;
  readonly getImageSize: () => { width: number; height: number } | null;
  readonly getSelectedAnnotationId: () => AnnotationId | null;
  readonly getAnnotationState: () => AnnotationState<OsdFields>;
  readonly getImageId: () => ImageId | undefined;
  /** Active context, so a stroke cannot target a mask from another one. */
  readonly getActiveContextId: () => AnnotationContextId | null;
  readonly getFill?: (() => string) | undefined;
  /**
   * Cap on the pixels one mask may allocate. Only ever lowers the shared
   * `DEFAULT_MAX_MASK_PIXELS` ceiling — see {@link BrushOptions.maxPixels}.
   */
  readonly maxPixels?: number | undefined;
}

/** State mutations the brush triggers. */
export interface BrushConfigDispatchers {
  readonly addAnnotation: (annotation: OsdAnnotation) => void;
  readonly updateAnnotation: (
    id: AnnotationId,
    imageId: ImageId,
    patch: ReturnType<typeof maskAnnotationFields>,
  ) => void;
  readonly deleteAnnotation: (id: AnnotationId, imageId: ImageId) => void;
  readonly setSelectedAnnotation: (id: AnnotationId | null) => void;
  readonly adjustBrushRadius: (direction: 1 | -1) => void;
  /**
   * Called when a stroke would push the mask past {@link
   * BrushConfigAccessors.maxPixels}. The stroke is abandoned with the mask
   * unchanged, so this is the only chance to tell the user why nothing
   * happened.
   */
  readonly onCapacityExceeded?: ((error: MaskCapacityExceededError) => void) | undefined;
}

/**
 * Builds the brush tool's configuration from framework state, so Solid and
 * React share one implementation of "which mask does this stroke paint into,
 * and what happens when it ends".
 *
 * A stroke refines the selected mask when one is selected on the current
 * image, and otherwise starts a new mask — which is then selected, so the
 * next stroke continues refining it rather than stacking a second annotation.
 */
export function buildSegmentationBrushConfig(
  accessors: BrushConfigAccessors,
  dispatchers: BrushConfigDispatchers,
): SegmentationBrushToolConfig {
  // Clamped *and* validated, not trusted. Clamped because painting above the
  // shared ceiling would produce a mask that cannot be rendered, exported, or
  // re-imported — every one of those paths enforces `DEFAULT_MAX_MASK_PIXELS`,
  // and the validation schema's copy is a module constant with no per-call
  // override. Validated because `Math.min` passes `NaN` and negatives straight
  // through to the buffer's constructor, which raises a plain `RangeError` —
  // not the `MaskCapacityExceededError` the tool knows to catch — so it escaped
  // into Fabric's dispatch on every pointer-down. The brush radius is screened
  // for the same reason a few lines from here.
  const requested = accessors.maxPixels;
  const maxPixels =
    requested === undefined || !Number.isFinite(requested) || requested <= 0
      ? undefined
      : Math.min(requested, DEFAULT_MAX_MASK_PIXELS);

  /** The fill recorded on the mask currently being refined, if any. */
  let targetFill: string | undefined;

  const resolveTarget = (): BrushTarget | null => {
    const id = accessors.getSelectedAnnotationId();
    const imageId = accessors.getImageId();
    targetFill = undefined;
    if (!id || !imageId) return null;

    const annotation = accessors.getAnnotationState().byImage[imageId]?.[id];
    if (!annotation || annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) return null;

    // Selection is global, but a stroke must never reach into a context the
    // user is not working in — that annotation may not even be displayed.
    const activeContextId = accessors.getActiveContextId();
    if (activeContextId && annotation.contextId !== activeContextId) return null;

    // Remember the mask's own tint; re-encoding without it would silently
    // repaint an imported red mask in the default blue.
    targetFill = annotation.rawAnnotationData.data.fill;
    return {
      annotationId: id,
      // The same cap the buffer will use. Decoding under the default while the
      // host raised it would refuse to reopen a mask the host allowed to exist.
      snapshot: decodeCanonical(annotation.rawAnnotationData.data, { maxPixels }),
      // Handed to the tool so the live preview paints in the mask's own colour
      // instead of flashing the default blue for the length of the stroke.
      ...(targetFill !== undefined ? { fill: targetFill } : {}),
    };
  };

  const commit = (stroke: BrushStrokeCommit): void => {
    const isEmpty = stroke.snapshot.width === 0 || stroke.snapshot.height === 0;

    if (stroke.annotationId) {
      // Erasing the last pixel would otherwise leave an annotation that renders
      // nothing, cannot be clicked, and still counts against the tool's limit.
      if (isEmpty) {
        dispatchers.deleteAnnotation(stroke.annotationId, stroke.imageId);
        dispatchers.setSelectedAnnotation(null);
        return;
      }
      dispatchers.updateAnnotation(
        stroke.annotationId,
        stroke.imageId,
        maskAnnotationFields(stroke.snapshot, accessors.getFill?.() ?? targetFill),
      );
      return;
    }

    // An entirely erased first stroke would produce an empty mask; there is
    // nothing worth creating.
    if (isEmpty) return;

    const fill = accessors.getFill?.();
    const id = createAnnotationId(generateId());
    dispatchers.addAnnotation(
      createMaskAnnotation(stroke.snapshot, {
        id,
        imageId: stroke.imageId,
        contextId: stroke.contextId,
        ...(fill !== undefined ? { fill } : {}),
      }),
    );
    // Select it so the next stroke refines this mask instead of starting another.
    dispatchers.setSelectedAnnotation(id);
  };

  return {
    getBrushRadius: accessors.getBrushRadius,
    isErasing: accessors.isErasing,
    getImageSize: accessors.getImageSize,
    getTarget: resolveTarget,
    onCommit: commit,
    onAdjustRadius: dispatchers.adjustBrushRadius,
    ...(accessors.getFill !== undefined ? { getFill: accessors.getFill } : {}),
    ...(maxPixels !== undefined ? { maxPixels } : {}),
    ...(dispatchers.onCapacityExceeded !== undefined
      ? { onCapacityExceeded: dispatchers.onCapacityExceeded }
      : {}),
  };
}
