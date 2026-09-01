import type { AnnotationStyle } from '@osdlabel/annotation';

/**
 * Dash length (screen pixels) used for an in-progress preview when the resolved
 * style specifies no `strokeDashArray` of its own. Screen-relative so the dash
 * rhythm reads the same at every zoom level.
 */
export const DEFAULT_PREVIEW_DASH_SCREEN_PX = 5;

/** Fabric options for an in-progress drawing preview. */
export interface PreviewOptions {
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly strokeDashArray: number[];
  readonly opacity: number;
  readonly selectable: false;
  readonly evented: false;
  readonly strokeUniform: true;
  readonly objectCaching: false;
}

/**
 * Builds the Fabric options for a preview object from the resolved annotation
 * style, so an in-progress shape is drawn in the same colour and stroke width
 * as the annotation it will become.
 *
 * The preview stays visually distinct from committed annotations by being
 * dashed and unfilled; the dash pattern comes from the style when it defines
 * one, otherwise from {@link DEFAULT_PREVIEW_DASH_SCREEN_PX}.
 *
 * Preview objects deliberately carry **no `id`** (that property is reserved for
 * annotation objects) — callers should also set `_readOnly = true` on the
 * created object so `FabricOverlay.setMode` keeps it inert.
 *
 * @param style Resolved style (`DEFAULT_ANNOTATION_STYLE` merged with the tool
 *   constraint's `defaultStyle`).
 * @param zoom Current canvas zoom, used to keep the default dash pattern
 *   constant in screen pixels.
 */
export function getPreviewOptions(style: AnnotationStyle, zoom: number): PreviewOptions {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const dash = DEFAULT_PREVIEW_DASH_SCREEN_PX / safeZoom;

  return {
    fill: 'transparent',
    stroke: style.strokeColor,
    strokeWidth: style.strokeWidth,
    strokeDashArray: style.strokeDashArray ? [...style.strokeDashArray] : [dash, dash],
    opacity: style.opacity,
    selectable: false,
    evented: false,
    strokeUniform: true,
    objectCaching: false,
  };
}
