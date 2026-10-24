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
   * (render p50 20.8 ms vs 0.6 ms at 50 annotations per slice).
   */
  readonly objectCaching?: boolean | undefined;
  /**
   * Keep revived vector objects across frame steps (a bounded LRU, revived a
   * few frames ahead of the scroll) instead of reviving each frame's objects
   * from their payloads on every step. Default `false`: the frame-axis PoC
   * measured no throughput gain for the reuse once object caching is off, at
   * up to twice the memory.
   */
  readonly reuseObjects?: boolean | undefined;
}

/** The values {@link FrameCellOptions} fields take when unset. */
export const DEFAULT_FRAME_CELL_OPTIONS = {
  drawer: 'canvas',
  objectCaching: false,
  reuseObjects: false,
} as const satisfies Required<FrameCellOptions>;
