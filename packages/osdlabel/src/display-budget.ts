import { MAX_MASK_CANVAS_PIXELS } from '@osdlabel/fabric-annotations';

/**
 * The display budget a host's `brushOptions.maxCanvasPixels` means, as the
 * renderer applies it: absent, the default `MAX_MASK_CANVAS_PIXELS`; anything
 * not a positive finite number, no budget (`Infinity`). The bindings compare
 * and pass this, so an equal budget — `NaN` included, which never equals
 * itself — is never mistaken for a change that redraws every mask.
 */
export function displayBudget(maxCanvasPixels: number | undefined): number {
  if (maxCanvasPixels === undefined) return MAX_MASK_CANVAS_PIXELS;
  return Number.isFinite(maxCanvasPixels) && maxCanvasPixels > 0 ? maxCanvasPixels : Infinity;
}
