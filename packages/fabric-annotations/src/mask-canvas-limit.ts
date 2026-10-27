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

  /**
   * @param options `cause`: what made the limit final, such as a coarsening
   * strategy that threw where coarsening back would have fitted the canvas;
   * `causeText` describes it, and replaces the generic advice.
   */
  constructor(
    width: number,
    height: number,
    maxPixels?: number,
    options?: { readonly cause: unknown; readonly causeText: string },
  ) {
    const tooLong = width > MAX_MASK_CANVAS_SIDE || height > MAX_MASK_CANVAS_SIDE;
    super(
      options !== undefined
        ? `A mask ${width} x ${height} cells wide cannot be drawn, and coarsening it back to a ` +
            `grid that can failed: ${options.causeText}. It is kept, and exports as usual.`
        : tooLong || maxPixels === undefined
          ? `A mask ${width} x ${height} cells wide cannot be drawn: browsers refuse a canvas side ` +
            `longer than ${MAX_MASK_CANVAS_SIDE} pixels. It is kept, and exports as usual; ` +
            `paint a narrower region, or split it into separate masks.`
          : `A mask ${width} x ${height} cells wide at its coarsest cannot be drawn within a ` +
            `display budget of ${maxPixels} canvas pixels. It is kept, and exports as usual; ` +
            `raise brushOptions.maxCanvasPixels.`,
      options !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'MaskCanvasTooLargeError';
    this.width = width;
    this.height = height;
    this.maxSide = MAX_MASK_CANVAS_SIDE;
    this.maxPixels = tooLong ? undefined : maxPixels;
  }
}

/**
 * Thrown by the renderer instead of drawing a non-empty mask blank: the
 * display mip it had to use, to fit the display budget or the canvas side,
 * has no set cell left, because every set cell was thinner than a mip cell (a
 * one-pixel line, or a sparse pattern; the majority rule keeps the mip
 * unbiased, not faithful to such features). The mask is unchanged, and
 * exports as usual. A host's cell reports it as a skipped annotation (#243).
 */
export class MaskDisplayMipEmptyError extends Error {
  /** The mask's box, in cells at its own downsample. */
  readonly width: number;
  readonly height: number;
  /** The mask's own downsample. */
  readonly downsample: number;
  /** The display mip's downsample, at which nothing was left. */
  readonly mipDownsample: number;
  /** The display budget it was drawn under. */
  readonly maxPixels: number;

  constructor(
    width: number,
    height: number,
    downsample: number,
    mipDownsample: number,
    maxPixels: number,
  ) {
    super(
      `A mask ${width} x ${height} cells wide is drawn from a display mip at downsample ` +
        `${mipDownsample}, to fit a display budget of ${maxPixels} canvas pixels and a canvas ` +
        `side of ${MAX_MASK_CANVAS_SIDE}, and none of its cells survive there: they are ` +
        `thinner than a mip cell. It is kept, and exports as usual; raise ` +
        `brushOptions.maxCanvasPixels, or split it into separate masks.`,
    );
    this.name = 'MaskDisplayMipEmptyError';
    this.width = width;
    this.height = height;
    this.downsample = downsample;
    this.mipDownsample = mipDownsample;
    this.maxPixels = maxPixels;
  }
}

/** What the brush reports when a stroke cannot go on: a mask too large to hold, or to draw. */
export type BrushCapacityError = MaskCapacityExceededError | MaskCanvasTooLargeError;
