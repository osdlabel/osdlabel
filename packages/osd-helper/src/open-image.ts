import type OpenSeadragon from 'openseadragon';
import type { ImageSource } from '@osdlabel/annotation';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

/**
 * Open an image source in an OpenSeadragon viewer.
 *
 * Simple image URLs (recognized by file extension) are opened with
 * `{ type: 'image', url }`. All other URLs are passed directly to
 * `viewer.open()` (assumed to be DZI or other tile sources).
 */
export function openImage(viewer: OpenSeadragon.Viewer, source: ImageSource): void {
  const url = source.tileSource;
  // Remove query string and hash, then check extension
  const path = ((url || '').split(/[?#]/)[0] ?? '').toLowerCase();
  const isSimpleImage = SUPPORTED_EXTENSIONS.some((ext) => path.endsWith(ext));

  if (isSimpleImage) {
    viewer.open({ type: 'image', url });
  } else {
    viewer.open(url);
  }
}
