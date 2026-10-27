import { Color, FabricImage, type FabricObject } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import {
  MAX_MASK_DOWNSAMPLE,
  decodeCanonicalRaster,
  majorityCoarsen,
  type MaskCellBox,
  type MaskRaster,
} from '@osdlabel/mask';
import {
  MAX_MASK_CANVAS_PIXELS,
  MAX_MASK_CANVAS_SIDE,
  MaskCanvasTooLargeError,
  MaskDisplayMipEmptyError,
} from './mask-canvas-limit.js';

/** Tint used when a mask envelope carries no `fill` of its own. */
export const DEFAULT_MASK_FILL = 'rgba(33, 150, 243, 0.45)';

export interface BuildMaskFabricObjectOptions {
  /** Annotation id, stored on the object so it is recognised as an annotation. */
  readonly id: string;
  /** Overrides the tint recorded in the envelope. */
  readonly fill?: string | undefined;
  /**
   * The most canvas pixels to draw the mask with: past it, the mask is drawn
   * from a display mip. Defaults to {@link MAX_MASK_CANVAS_PIXELS}.
   */
  readonly maxCanvasPixels?: number | undefined;
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
 * A mask with more cells than the display budget
 * ({@link BuildMaskFabricObjectOptions.maxCanvasPixels}), or a side longer than
 * {@link MAX_MASK_CANVAS_SIDE}, is drawn from a display mip rather than in full.
 *
 * Returns `null` for an empty mask, which has no pixels to draw. Throws if
 * handed raw data that is not a mask payload, and throws
 * {@link MaskDisplayMipEmptyError} when the mip it fits has no set cell left,
 * and {@link MaskCanvasTooLargeError} when even the coarsest mip would not fit — a
 * host's cell reports it as a skipped annotation.
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
  const raster = displayRaster(
    decodeCanonicalRaster(raw.data),
    options.maxCanvasPixels ?? MAX_MASK_CANVAS_PIXELS,
  );
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
 * What to draw for a mask: the mask itself when its canvas fits — both the
 * display budget and the longest side any browser draws — and otherwise a
 * display mip, the mask halved by the built-in majority rule until it fits.
 * Drawn at its own scale (`d · 2^k`), it covers the same image region: the
 * mask is slightly blockier at high zoom, and draws at all on a device whose
 * canvas limit it was past (iOS). The stored mask is never touched.
 *
 * Throws {@link MaskCanvasTooLargeError} only if no downsample up to the
 * largest makes it fit, and {@link MaskDisplayMipEmptyError} if the mip that
 * fits has no set cell left while the mask has some.
 */
function displayRaster(raster: MaskRaster, maxCanvasPixels: number): MaskRaster {
  const budget =
    Number.isFinite(maxCanvasPixels) && maxCanvasPixels > 0 ? maxCanvasPixels : Infinity;
  const fits = (r: MaskRaster) =>
    r.cells.width <= MAX_MASK_CANVAS_SIDE &&
    r.cells.height <= MAX_MASK_CANVAS_SIDE &&
    r.cells.width * r.cells.height <= budget;
  let display = raster;
  while (!fits(display)) {
    if (display.downsample * 2 > MAX_MASK_DOWNSAMPLE) {
      throw new MaskCanvasTooLargeError(display.cells.width, display.cells.height, budget);
    }
    display = majorityCoarsen(display);
  }
  // A mip with nothing left would draw a set mask blank, silently.
  if (display !== raster && display.cellCount === 0 && raster.cellCount > 0) {
    throw new MaskDisplayMipEmptyError(
      raster.cells.width,
      raster.cells.height,
      raster.downsample,
      display.downsample,
      budget,
    );
  }
  return display;
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
