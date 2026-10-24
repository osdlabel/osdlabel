/**
 * How a viewer cell renders a multi-frame source (a CT/MR stack, a cine
 * loop). Applies only to cells showing such a source; single-frame images
 * keep the library's defaults.
 */
export interface FrameCellOptions {
  /**
   * The OpenSeadragon drawer for these cells. Default `'canvas'`: a frame step
   * repaints one tile in place, which the canvas drawer draws from the tile's
   * own canvas, while the WebGL drawer re-uploads the whole texture per step.
   * WebGL was only measured on a software-emulated GPU (SwiftShader), where
   * it could not keep up; choose it explicitly to try it on real hardware.
   */
  readonly drawer?: 'canvas' | 'webgl' | undefined;
  /**
   * Fabric per-object render caching for the vector annotation objects in
   * these cells. Default `false`: every frame step adds a frame's worth of new
   * objects, and building each object's cache canvas dominated the step
   * (Fabric render p50 31.8 ms vs 1.1 ms at 50 annotations per slice; 10.7-11.3
   * vs 29.2-32.6 slices/s in the Solid binding, frame-axis PoC).
   */
  readonly objectCaching?: boolean | undefined;
  /**
   * Keep revived vector objects across frame steps (a bounded LRU, revived a
   * few frames ahead of the scroll) instead of reviving each frame's objects
   * from their payloads on every step. Default `false`: with object caching
   * off, the frame-axis PoC measured reuse slower than rebuilding in every
   * pass (cold pass at 50 per slice: 20.2 vs 29.2 slices/s, median of 5) and
   * heavier at 10 and 50 per slice (PSS 304 vs 212 MB, 442 vs 376 MB). Kept
   * only so the comparison can be re-run; a production binding drops it.
   */
  readonly reuseObjects?: boolean | undefined;
}

/** The values {@link FrameCellOptions} fields take when unset. */
export const DEFAULT_FRAME_CELL_OPTIONS = {
  drawer: 'canvas',
  objectCaching: false,
  reuseObjects: false,
} as const satisfies Required<FrameCellOptions>;
