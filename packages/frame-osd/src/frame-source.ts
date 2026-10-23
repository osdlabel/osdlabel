/**
 * Where a presenter gets a frame's pixels from.
 *
 * Deliberately minimal and synchronous at the point of use: `paint` either
 * draws frame `index` into the context now and returns `true`, or returns
 * `false` because the frame is not resident yet (still decoding, still
 * downloading), in which case the presenter keeps showing what it showed. A
 * source that needs to fetch or decode does that ahead of time, in
 * `prefetch`, so a wheel tick never waits on the network.
 *
 * What a frame *is* — 8-bit gray expanded through a LUT, an `ImageBitmap`, a
 * WebCodecs `VideoFrame`, a decoded DICOM frame windowed on the fly — is the
 * source's business. The presenter only ever sees a 2D context.
 */
export interface FrameSource {
  /** Frame width in image pixels; every frame of a source has the same size. */
  readonly width: number;
  /** Frame height in image pixels. */
  readonly height: number;
  /** Number of frames on the axis. */
  readonly count: number;
  /** Draw frame `index` into `ctx` (sized width x height). `false` if not resident. */
  paint(index: number, ctx: CanvasRenderingContext2D): boolean;
  /** Make frames resident ahead of use. Optional: an in-memory source has nothing to do. */
  prefetch?(indices: readonly number[]): Promise<void>;
}
