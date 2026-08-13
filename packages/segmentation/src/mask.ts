/**
 * A dense, row-major segmentation mask in the image's pixel grid.
 *
 * `data` has length `width * height`. A pixel at `(x, y)` is `data[y * width + x]`.
 * For a `Uint8Array` a non-zero value is foreground; for a `Float32Array` the
 * value is treated as a probability/logit compared against a threshold. This is
 * the input to {@link import('./mask-to-contours.js').maskToContours}.
 */
export interface SegmentationMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Float32Array;
}
