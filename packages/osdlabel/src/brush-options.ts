import type { AnnotationId } from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId } from '@osdlabel/viewer-api';
import type { CoarsenStrategy } from '@osdlabel/mask';
import type { BrushCapacityError } from '@osdlabel/fabric-annotations';

/** A stroke that coarsened its mask to fit the cap; see {@link BrushOptions.onCoarsen}. */
export interface CoarsenEvent {
  readonly annotationId: AnnotationId;
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  /** The mask's downsample before the stroke. */
  readonly from: number;
  /** Its downsample after: always above `from`. */
  readonly to: number;
}

/**
 * How masks are drawn relative to the selection.
 *
 * Every mask renders in its own tint (the fill recorded on it, else
 * `DEFAULT_MASK_FILL`), so with several masks on an image nothing marks the
 * one the brush will refine. While a mask is selected, the others are dimmed;
 * optionally the selected one is also recoloured. With nothing selected, all
 * masks render as they are.
 */
export interface MaskStyle {
  /**
   * Tint drawn for the selected mask in place of its own, as a CSS colour.
   * Display only — the mask's recorded `fill` is untouched, and the brush's
   * live preview paints in this colour while refining so nothing flashes.
   * Omit to keep the mask's own tint and distinguish it by dimming the rest.
   */
  readonly selectedFill?: string | undefined;
  /**
   * Opacity applied to every *other* mask while one is selected, `0`–`1`.
   * Multiplies the alpha already in each mask's tint. Defaults to
   * `DEFAULT_UNSELECTED_MASK_OPACITY` (`0.4`); `1` turns dimming off.
   */
  readonly unselectedOpacity?: number | undefined;
}

/**
 * Host-supplied settings for the segmentation brush.
 *
 * Separate from `SegmentationBrushToolConfig`, which is the tool's full
 * interface and is assembled per cell from reactive state. This is the small
 * subset a consumer actually configures, and it is what the framework packages
 * accept as a prop.
 */
export interface BrushOptions {
  /**
   * How the selected mask is told apart from the others. See {@link MaskStyle}.
   */
  readonly maskStyle?: MaskStyle | undefined;
  /**
   * The display budget: the most canvas pixels one mask is drawn with.
   * Defaults to `MAX_MASK_CANVAS_PIXELS` (16 Mi, 4,096², what iOS Safari
   * draws). A mask with more cells is drawn from a display mip — halved by the
   * built-in majority rule until it fits, so slightly blockier at high zoom —
   * and the stored mask is never touched. `Infinity` draws every mask in full,
   * up to the 32,767-pixel side every browser draws.
   */
  readonly maxCanvasPixels?: number | undefined;
  /**
   * Cap on the cells one mask's box may hold (image pixels at full
   * resolution).
   *
   * **Lowers** the limit; it cannot raise it. `DEFAULT_MAX_MASK_PIXELS` (64 Mi
   * cells) is a ceiling the whole library shares — the validation schema
   * enforces it on every mask that is loaded, and it is a module constant, not
   * a per-call option. A mask painted above it would render, export, and
   * re-import as an error, so a larger value here is clamped rather than
   * honoured.
   *
   * It is not only a guard against pathological strokes. A mask is stored
   * cropped to what you painted, so the cap bounds its bounding box: 8192 x
   * 8192 image pixels at full resolution — about 2 mm square on a slide
   * scanned at 0.25 µm a pixel — whether the box is solid or holds two dabs at
   * opposite corners. A larger region is a separate mask. Lower the cap to
   * fail sooner, or below a device's canvas limits.
   */
  readonly maxPixels?: number | undefined;
  /**
   * Called when a stroke would exceed {@link BrushOptions.maxPixels}, or would
   * make the mask too wide or tall to draw (`MaskCanvasTooLargeError`: a side
   * past `MAX_MASK_CANVAS_SIDE` cells).
   *
   * The stroke is abandoned whole and the mask left unchanged, so nothing on
   * screen changes — this is the only chance to tell the user why.
   */
  readonly onCapacityExceeded?: ((error: BrushCapacityError) => void) | undefined;
  /**
   * The rule a stroke coarsens a mask by when it outgrows the cap, in a
   * context that allows it (`ToolConstraint.brush.maxDownsample`). Defaults to
   * `majorityCoarsen`. It must meet the contract `verifyCoarsenStrategy`
   * checks — deterministic, a valid coarsening, and undoing re-gridding finer —
   * and runs at most once per overflow, between pointer events, so a slower
   * one delays a single segment. Its quality is the host's to judge: the
   * precision bounds osdlabel holds itself to are for the built-in. Read at
   * each overflow; changing it does not rebuild the tool.
   */
  readonly coarsen?: CoarsenStrategy | undefined;
  /**
   * Called when a committed stroke coarsened its mask, so the host can say
   * so: the mask is now at `to`, which loses detail finer than its cells.
   * Not called when a stroke re-grids a mask finer.
   */
  readonly onCoarsen?: ((event: CoarsenEvent) => void) | undefined;
}
