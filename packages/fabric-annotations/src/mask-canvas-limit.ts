import type { MaskCapacityExceededError } from '@osdlabel/mask';

/**
 * The longest canvas side every supported browser will draw: Firefox's
 * per-side limit (Chromium allows 65,535). A mask is drawn as one canvas pixel
 * per cell, so a mask wider or taller than this many cells — well inside the
 * cell cap, as a 70,000 x 900 strip is — would otherwise draw blank.
 */
export const MAX_MASK_CANVAS_SIDE = 32_767;

/**
 * The default display budget: the most canvas pixels one mask is drawn with.
 * 16 Mi is 4,096², what iOS Safari draws; a mask with more cells is drawn from
 * a display mip (see `buildMaskFabricObject`), slightly blockier at high zoom
 * and never stored. A host may raise or lower it (`BrushOptions.maxCanvasPixels`).
 */
export const MAX_MASK_CANVAS_PIXELS = 16 * 1024 * 1024;

/**
 * Thrown instead of drawing a brush stroke's live preview on a canvas too long
 * to draw, and by the renderer when not even its coarsest display mip fits —
 * which a valid mask reaches only under a host display budget of a few pixels.
 */
export class MaskCanvasTooLargeError extends RangeError {
  /** The canvas asked for, in canvas pixels (one per cell). */
  readonly width: number;
  readonly height: number;
  /** The longest side that can be drawn, {@link MAX_MASK_CANVAS_SIDE}. */
  readonly maxSide: number;
  /** The display budget it was drawn under, when that is what it missed. */
  readonly maxPixels: number | undefined;

  constructor(width: number, height: number, maxPixels?: number) {
    const tooLong = width > MAX_MASK_CANVAS_SIDE || height > MAX_MASK_CANVAS_SIDE;
    super(
      tooLong || maxPixels === undefined
        ? `A mask ${width} x ${height} cells wide cannot be drawn: browsers refuse a canvas side ` +
            `longer than ${MAX_MASK_CANVAS_SIDE} pixels. It is kept, and exports as usual; ` +
            `paint a narrower region, or split it into separate masks.`
        : `A mask ${width} x ${height} cells wide at its coarsest cannot be drawn within a ` +
            `display budget of ${maxPixels} canvas pixels. It is kept, and exports as usual; ` +
            `raise brushOptions.maxCanvasPixels.`,
    );
    this.name = 'MaskCanvasTooLargeError';
    this.width = width;
    this.height = height;
    this.maxSide = MAX_MASK_CANVAS_SIDE;
    this.maxPixels = tooLong ? undefined : maxPixels;
  }
}

/** What the brush reports when a stroke cannot go on: a mask too large to hold, or to draw. */
export type BrushCapacityError = MaskCapacityExceededError | MaskCanvasTooLargeError;
