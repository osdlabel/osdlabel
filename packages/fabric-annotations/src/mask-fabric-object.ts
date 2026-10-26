import { Color, FabricImage, type FabricObject } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import { decodeCanonicalRaster } from '@osdlabel/mask';

/** Tint used when a mask envelope carries no `fill` of its own. */
export const DEFAULT_MASK_FILL = 'rgba(33, 150, 243, 0.45)';

export interface BuildMaskFabricObjectOptions {
  /** Annotation id, stored on the object so it is recognised as an annotation. */
  readonly id: string;
  /** Overrides the tint recorded in the envelope. */
  readonly fill?: string | undefined;
}

/**
 * Renders a mask as a Fabric `Image` backed by an offscreen canvas.
 *
 * Going through a regular Fabric object rather than a bespoke canvas layer
 * means the mask inherits everything the overlay already does correctly —
 * pan, zoom, rotation, and flip all come from the existing viewport transform,
 * and selection, z-ordering, and the `id`-based clear filter keep working
 * unchanged.
 *
 * The object is deliberately not transformable: a mask is edited by painting,
 * not by dragging handles, so moving or scaling it would silently desynchronise
 * the pixels from their image-space coordinates.
 *
 * Returns `null` for an empty mask, which has no pixels to draw. Throws if
 * handed raw data that is not a mask payload.
 */
export function buildMaskFabricObject(
  raw: MaskRawAnnotationData,
  options: BuildMaskFabricObjectOptions,
): FabricObject | null {
  // Unreachable for a TypeScript caller — `MaskRawAnnotationData.format` is
  // the literal — so this is here for JavaScript ones. It throws rather than
  // returning null because `null` already means "an empty mask, nothing to
  // draw": conflating the two would render a Fabric envelope as silence
  // instead of naming the mistake. Same reasoning as
  // `buildFabricObjectFromGeometry`'s default branch.
  if (raw.format !== MASK_RAW_FORMAT) {
    throw new TypeError(
      `buildMaskFabricObject needs ${MASK_RAW_FORMAT} raw data, got ${String(raw.format)}`,
    );
  }

  // Read as runs, under the format's cap; this renderer then draws one canvas
  // over the box. A tiled renderer would draw the same raster per tile.
  const raster = decodeCanonicalRaster(raw.data);
  const cells = raster.cells;
  if (cells.width === 0 || cells.height === 0) return null;

  const [red, green, blue, alpha] = new Color(
    options.fill ?? raw.data.fill ?? DEFAULT_MASK_FILL,
  ).getSource();
  const alphaByte = Math.round((alpha ?? 1) * 255);

  const canvas = document.createElement('canvas');
  canvas.width = cells.width;
  canvas.height = cells.height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const imageData = context.createImageData(cells.width, cells.height);
  const pixels = imageData.data;
  raster.forEachSpan((cy, x0, x1) => {
    const rowStart = (cy - cells.y) * cells.width - cells.x;
    for (let i = rowStart + x0; i < rowStart + x1; i++) {
      const offset = i * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alphaByte;
    }
  });
  context.putImageData(imageData, 0, 0);

  // One canvas pixel per stored cell, scaled up to the image pixels each cell
  // covers. The overlay's viewport transform does the rest, as for any other
  // object; with smoothing off (below) a cell renders as a crisp block. Cells
  // along a clipped image edge are drawn full-size, so a mask touching that
  // edge overhangs the image by under one cell — outside the image, where
  // nothing else is drawn.
  const downsample = raster.downsample;
  return new FabricImage(canvas, {
    left: cells.x * downsample,
    top: cells.y * downsample,
    scaleX: downsample,
    scaleY: downsample,
    originX: 'left',
    originY: 'top',
    id: options.id,
    selectable: true,
    evented: true,
    // Painting is the only way to change a mask.
    lockMovementX: true,
    lockMovementY: true,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
    hasControls: false,
    // A mask is mostly transparent box: hit-test its pixels, not its bounding
    // box, so a click through a sparse mask reaches the shape beneath it.
    perPixelTargetFind: true,
    // Mask edges should stay crisp when zoomed in; blockiness is correct for
    // pixel data, and caching a canvas-backed image buys nothing.
    imageSmoothing: false,
    objectCaching: false,
  });
}
