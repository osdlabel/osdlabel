import type { FabricObject } from 'fabric';
import {
  MASK_RAW_FORMAT,
  createAnnotationId,
  generateId,
  type AnnotationId,
  type MaskRawAnnotationData,
} from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationState, ImageId } from '@osdlabel/viewer-api';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
import {
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  decodeCanonicalRaster,
} from '@osdlabel/mask';
import { DEFAULT_MASK_FILL, maskFabricObjectFromCanvas } from '@osdlabel/fabric-annotations';
import type {
  BrushCapacityError,
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
   * The tint the selected mask is *displayed* in, if the host overrides it
   * (`MaskStyle.selectedFill`). The target of a refining stroke is by
   * definition the selected mask, so the live preview paints in this colour;
   * otherwise it would flash the mask's own tint for the length of the stroke.
   * Display only: it is never recorded on the annotation.
   */
  readonly getSelectedFill?: (() => string | undefined) | undefined;
  /**
   * Cap on the pixels one mask may allocate. Only ever lowers the shared
   * `DEFAULT_MAX_MASK_PIXELS` ceiling — see {@link BrushOptions.maxPixels}.
   */
  readonly maxPixels?: number | undefined;
  /**
   * The key bound to the New mask shortcut (`KeyboardShortcutMap.newMask`), so
   * the capacity message can point to it: "Start a separate mask with New
   * mask (n)".
   */
  readonly getNewMaskShortcut?: (() => string) | undefined;
  /**
   * Whether a new mask may be started now — the context is below its limit
   * (`canAddAnnotation(status, 'segmentationBrush')`). The capacity message
   * points to New mask only when it would help: the stroke was refining, and
   * a mask may still be added. Omitted, it is assumed it may.
   */
  readonly canStartNewMask?: (() => boolean) | undefined;
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
  readonly onCapacityExceeded?: ((error: BrushCapacityError) => void) | undefined;
  /**
   * Hands the cell the committed mask's object, built from the stroke's live
   * preview, before the commit is written — so the rebuild the write triggers
   * shows it without decoding and re-rasterizing the mask (#238). `fill` is
   * the tint override the object was drawn in, `undefined` for the mask's own;
   * the cell keys its cache on it (`MaskObjectCache.seed`).
   */
  readonly seedMaskObject?: ((seed: MaskObjectSeed) => void) | undefined;
}

/** A committed mask's object, built from the brush's preview; see `seedMaskObject`. */
export interface MaskObjectSeed {
  readonly annotationId: AnnotationId;
  readonly rawAnnotationData: MaskRawAnnotationData;
  /** The tint override it is drawn in, or `undefined` for the mask's own. */
  readonly fill: string | undefined;
  readonly object: FabricObject;
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
  /** Whether the stroke under way refines a mask, rather than creating one. */
  let strokeRefines = false;

  /** The selected mask a stroke would refine, or `null` when it would create one. */
  const selectedMask = () => {
    const id = accessors.getSelectedAnnotationId();
    const imageId = accessors.getImageId();
    if (!id || !imageId) return null;

    const annotation = accessors.getAnnotationState().byImage[imageId]?.[id];
    if (!annotation || annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) return null;

    // Selection is global, but a stroke must never reach into a context the
    // user is not working in — that annotation may not even be displayed.
    const activeContextId = accessors.getActiveContextId();
    if (activeContextId && annotation.contextId !== activeContextId) return null;
    return { id, data: annotation.rawAnnotationData.data };
  };

  const resolveTarget = (): BrushTarget | null => {
    targetFill = undefined;
    const selected = selectedMask();
    strokeRefines = selected !== null;
    if (!selected) return null;

    // Remember the mask's own tint; re-encoding without it would silently
    // repaint an imported red mask in the default blue.
    targetFill = selected.data.fill;
    // Handed to the tool so the live preview paints in the colour the mask is
    // currently *shown* in — the host's selected tint if there is one, else the
    // mask's own — instead of flashing the default blue for the stroke.
    const previewFill = accessors.getSelectedFill?.() ?? targetFill;
    return {
      annotationId: selected.id,
      // The same cap the buffer will use, so a mask the host's lowered cap
      // cannot hold is refused here, where it costs one decode, rather than by
      // the buffer after it.
      snapshot: decodeCanonicalRaster(selected.data, { maxPixels }),
      ...(previewFill !== undefined ? { fill: previewFill } : {}),
    };
  };

  const commit = (stroke: BrushStrokeCommit): void => {
    const isEmpty = stroke.snapshot.cells.width === 0 || stroke.snapshot.cells.height === 0;

    if (stroke.annotationId) {
      // Erasing the last pixel would otherwise leave an annotation that renders
      // nothing, cannot be clicked, and still counts against the tool's limit.
      if (isEmpty) {
        dispatchers.deleteAnnotation(stroke.annotationId, stroke.imageId);
        dispatchers.setSelectedAnnotation(null);
        return;
      }
      const fields = maskAnnotationFields(stroke.snapshot, accessors.getFill?.() ?? targetFill);
      seed(stroke, stroke.annotationId, fields.rawAnnotationData);
      dispatchers.updateAnnotation(stroke.annotationId, stroke.imageId, fields);
      return;
    }

    // An entirely erased first stroke would produce an empty mask; there is
    // nothing worth creating.
    if (isEmpty) return;

    const fill = accessors.getFill?.();
    const id = createAnnotationId(generateId());
    const annotation = createMaskAnnotation(stroke.snapshot, {
      id,
      imageId: stroke.imageId,
      contextId: stroke.contextId,
      ...(fill !== undefined ? { fill } : {}),
    });
    // Select it so the next stroke refines this mask instead of starting
    // another — and select it *first*. A context's last allowed mask leaves the
    // brush enabled only because that mask is selected; added first, there was
    // a moment at the limit with nothing selected, and a host whose effects run
    // on every write (Solid's do) switched the brush off in it.
    if (annotation.rawAnnotationData.format === MASK_RAW_FORMAT) {
      seed(stroke, id, annotation.rawAnnotationData);
    }
    dispatchers.setSelectedAnnotation(id);
    dispatchers.addAnnotation(annotation);
  };

  /**
   * Seeds the cell with the stroke's preview, when its tint is the one the
   * cell will draw the mask in: the selected tint the host overrides with, or
   * the mask's own when it overrides none. Anything else, the cell rebuilds.
   */
  const seed = (
    stroke: BrushStrokeCommit,
    annotationId: AnnotationId,
    rawAnnotationData: MaskRawAnnotationData,
  ): void => {
    const preview = stroke.preview;
    if (!preview || !dispatchers.seedMaskObject) return;
    const selectedFill = accessors.getSelectedFill?.();
    const ownFill = rawAnnotationData.data.fill ?? DEFAULT_MASK_FILL;
    let fill: string | undefined;
    if (selectedFill !== undefined) {
      if (preview.fill !== selectedFill) return;
      fill = selectedFill;
    } else if (preview.fill !== ownFill) {
      return;
    }
    dispatchers.seedMaskObject({
      annotationId,
      rawAnnotationData,
      fill,
      object: maskFabricObjectFromCanvas(
        preview.canvas,
        stroke.snapshot.cells,
        stroke.snapshot.downsample,
        annotationId,
      ),
    });
  };

  return {
    getBrushRadius: accessors.getBrushRadius,
    isErasing: accessors.isErasing,
    getImageSize: accessors.getImageSize,
    getTarget: resolveTarget,
    // The same answer as `getTarget`, without decoding: the cursor asks on
    // every pointer move.
    peekTarget: () => {
      const selected = selectedMask();
      return selected ? { downsample: selected.data.downsample ?? 1 } : null;
    },
    onCommit: commit,
    onAdjustRadius: dispatchers.adjustBrushRadius,
    ...(accessors.getFill !== undefined ? { getFill: accessors.getFill } : {}),
    ...(maxPixels !== undefined ? { maxPixels } : {}),
    ...(dispatchers.onCapacityExceeded !== undefined
      ? {
          onCapacityExceeded: withNewMaskAdvice(
            dispatchers.onCapacityExceeded,
            accessors,
            () => strokeRefines,
          ),
        }
      : {}),
  };
}

/**
 * Points a capacity failure at the remedy the brush offers — a separate mask,
 * started with the New mask action — when that remedy works: the stroke was
 * refining a mask (one creating a mask is helped only by a smaller region),
 * and a new mask may still be added (at the limit New mask is disabled).
 * Otherwise, and for errors other than the cell cap, the error is unchanged.
 */
function withNewMaskAdvice(
  report: (error: BrushCapacityError) => void,
  accessors: BrushConfigAccessors,
  strokeRefines: () => boolean,
): (error: BrushCapacityError) => void {
  return (error) => {
    const key = accessors.getNewMaskShortcut?.();
    if (
      !(error instanceof MaskCapacityExceededError) ||
      key === undefined ||
      key === '' ||
      !strokeRefines() ||
      !(accessors.canStartNewMask?.() ?? true)
    ) {
      report(error);
      return;
    }
    report(
      new MaskCapacityExceededError(
        error.requestedCells,
        error.maxCells,
        error.downsample,
        `Start a separate mask with New mask (${key}).`,
      ),
    );
  };
}
