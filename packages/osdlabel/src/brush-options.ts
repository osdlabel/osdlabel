import type { MaskCapacityExceededError } from '@osdlabel/mask';

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
   * Cap on the pixels one mask may allocate, in pixels.
   *
   * **Lowers** the limit; it cannot raise it. `DEFAULT_MAX_MASK_PIXELS` (64
   * megapixels) is a ceiling the whole library shares — the validation schema
   * enforces it on every mask that is loaded, and it is a module constant, not
   * a per-call option. A mask painted above it would render, export, and
   * re-import as an error, so a larger value here is clamped rather than
   * honoured.
   *
   * The cap exists for the pathological case rather than the ordinary one: a
   * mask is stored cropped to what you painted, but strokes at opposite corners
   * of a deep-zoom image have a bounding box the size of the image even though
   * almost nothing is painted. Lower it to fail fast on that.
   */
  readonly maxPixels?: number | undefined;
  /**
   * Called when a stroke would exceed {@link BrushOptions.maxPixels}.
   *
   * The stroke is abandoned whole and the mask left unchanged, so nothing on
   * screen changes — this is the only chance to tell the user why.
   */
  readonly onCapacityExceeded?: ((error: MaskCapacityExceededError) => void) | undefined;
}
