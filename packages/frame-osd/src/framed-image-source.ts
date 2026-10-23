import type { ImageSource } from '@osdlabel/viewer-api';
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
