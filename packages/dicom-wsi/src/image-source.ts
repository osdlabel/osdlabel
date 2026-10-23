import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import type { WsiPyramid } from './pyramid.js';
import type { WsiTileSourceSpec } from './tile-source.js';

/**
 * A DICOM WSI as an osdlabel `ImageSource`: the tile source plus the base
 * level's pixel spacing (µm). osdlabel's image space is then the base level's
 * Total Pixel Matrix — the coordinate system SR SCOORD and ANN 2D (Pixel
 * Origin Interpretation VOLUME) use, so annotations export without transform.
 */
export function wsiImageSource(
  pyramid: WsiPyramid,
  tileSource: WsiTileSourceSpec,
  options: { readonly id?: ImageId; readonly label?: string } = {},
): ImageSource {
  const base = pyramid.levels[pyramid.levels.length - 1]!;
  return {
    id: options.id ?? createImageId(base.sopInstanceUid),
    tileSource,
    label: options.label,
    pixelSpacing: pyramid.pixelSpacing,
  };
}
