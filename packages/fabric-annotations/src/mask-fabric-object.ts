import { Color, FabricImage, type FabricObject } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import { decodeCanonicalRaster, type MaskCellBox } from '@osdlabel/mask';
import { MAX_MASK_CANVAS_SIDE, MaskCanvasTooLargeError } from './mask-canvas-limit.js';

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
 * handed raw data that is not a mask payload, and throws
 * {@link MaskCanvasTooLargeError} for a mask more than
 * {@link MAX_MASK_CANVAS_SIDE} cells wide or tall, which no canvas can draw in
 * every browser — a host's cell reports it as a skipped annotation.
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
  // Refused, not drawn: past the limit an engine allocates the canvas but
  // draws nothing, so the mask would vanish with no error at all.
  if (cells.width > MAX_MASK_CANVAS_SIDE || cells.height > MAX_MASK_CANVAS_SIDE) {
    throw new MaskCanvasTooLargeError(cells.width, cells.height);
  }

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
  // One 32-bit word per pixel, so a span is a single native fill instead of
  // four byte writes per pixel: 58 ms to 17 on a 16-megapixel mask (#238).
  const words = new Uint32Array(imageData.data.buffer);
  const tint = packRgba(red, green, blue, alphaByte);
  raster.forEachSpan((cy, x0, x1) => {
    const rowStart = (cy - cells.y) * cells.width - cells.x;
    words.fill(tint, rowStart + x0, rowStart + x1);
  });
  context.putImageData(imageData, 0, 0);

  return maskFabricObjectFromCanvas(canvas, cells, raster.downsample, options.id);
}

/**
 * The Fabric object for a mask already drawn on `canvas`, one canvas pixel per
 * cell of `cells` at `downsample` — placed and configured exactly as
 * {@link buildMaskFabricObject} places a mask it draws itself. For a host that
 * has the pixels at hand: the brush's preview holds a committed stroke's mask,
 * so the cell can show it without decoding and re-rasterizing it.
 */
export function maskFabricObjectFromCanvas(
  canvas: HTMLCanvasElement,
  cells: MaskCellBox,
  downsample: number,
  id: string,
): FabricImage {
  // One canvas pixel per stored cell, scaled up to the image pixels each cell
  // covers. The overlay's viewport transform does the rest, as for any other
  // object; with smoothing off (below) a cell renders as a crisp block. Cells
  // along a clipped image edge are drawn full-size, so a mask touching that
  // edge overhangs the image by under one cell — outside the image, where
  // nothing else is drawn.
  return new FabricImage(canvas, {
    left: cells.x * downsample,
    top: cells.y * downsample,
    scaleX: downsample,
    scaleY: downsample,
    originX: 'left',
    originY: 'top',
    id,
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

/**
 * An RGBA pixel as the 32-bit word `ImageData`'s bytes make in this
 * platform's byte order — built through the bytes, so it is right on either.
 */
export function packRgba(red: number, green: number, blue: number, alpha: number): number {
  return new Uint32Array(Uint8ClampedArray.of(red, green, blue, alpha).buffer)[0]!;
}
