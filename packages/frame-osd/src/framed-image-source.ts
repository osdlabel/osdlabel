import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import type { FrameAxis } from '@osdlabel/frame';
import type { FrameSource } from './frame-source.js';

/**
 * An image source with a frame axis: still ONE `ImageId` (annotations live in
 * one `byImage` bucket and carry `frame`), plus the axis (what the frames are)
 * and a pixel provider (how to paint one).
 *
 * `tileSource` is unused by a presenter-backed cell; set it to whatever a
 * thumbnail or a single-frame fallback should open (e.g. the middle slice).
 */
export interface FramedImageSource extends ImageSource {
  readonly frameAxis: FrameAxis;
  readonly frameSource: FrameSource;
  /**
   * The alternative annotation model, for a series whose frames are separate
   * images: one `ImageId` per frame (e.g. each slice's SOPInstanceUID), in
   * axis order. When set, a cell keys the annotations it shows on
   * `sliceImageIds[frame]` (no `frame` field), and `id` is the series'
   * grouping id: the one grid assignment. Pixels are presented the same way.
   */
  readonly sliceImageIds?: readonly ImageId[] | undefined;
}

export function isFramedImageSource(source: ImageSource | undefined): source is FramedImageSource {
  if (source === undefined) return false;
  const s = source as Partial<FramedImageSource>;
  return (
    typeof s.frameAxis === 'object' &&
    s.frameAxis !== null &&
    typeof s.frameSource === 'object' &&
    s.frameSource !== null &&
    typeof s.frameSource.paint === 'function'
  );
}
