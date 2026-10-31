import type { MaskCapacityExceededError } from '@osdlabel/mask';

/**
 * The longest canvas side every supported browser will draw: Firefox's
 * per-side limit (Chromium allows 65,535). A mask is drawn as one canvas pixel
 * per cell, so a mask wider or taller than this many cells — well inside the
 * cell cap, as a 70,000 x 900 strip is — would otherwise draw blank.
 */
export const MAX_MASK_CANVAS_SIDE = 32_767;

/** Thrown instead of drawing a mask, or its live preview, on a canvas too long to draw. */
export class MaskCanvasTooLargeError extends RangeError {
  /** The canvas asked for, in canvas pixels (one per cell). */
  readonly width: number;
  readonly height: number;
  /** The longest side that can be drawn, {@link MAX_MASK_CANVAS_SIDE}. */
  readonly maxSide: number;

  constructor(width: number, height: number) {
    super(
      `A mask ${width} x ${height} cells wide cannot be drawn: browsers refuse a canvas side ` +
        `longer than ${MAX_MASK_CANVAS_SIDE} pixels. It is kept, and exports as usual; ` +
        `paint a narrower region, or split it into separate masks.`,
    );
    this.name = 'MaskCanvasTooLargeError';
    this.width = width;
    this.height = height;
    this.maxSide = MAX_MASK_CANVAS_SIDE;
  }
}

/** What the brush reports when a stroke cannot go on: a mask too large to hold, or to draw. */
export type BrushCapacityError = MaskCapacityExceededError | MaskCanvasTooLargeError;
