import type OpenSeadragon from 'openseadragon';

/**
 * How far below the home zoom (the "fit the whole image in the cell" zoom)
 * the user is allowed to zoom out. `0.5` means the image can be shrunk to
 * half its fitted size.
 *
 * This MUST stay relative — OSD's absolute `minZoomLevel` is expressed in
 * viewport zoom units, where `1` means "image width fills the viewport
 * width". Home zoom is only `1` when the image is the limiting dimension
 * horizontally; for an image whose aspect ratio is taller than the cell's,
 * home zoom is `imageAspect / containerAspect`, which can be far below any
 * fixed floor. With an absolute floor above home zoom, OSD's
 * `applyConstraints()` (which runs on every mouse-up) snaps the viewer to
 * the floor and then refuses to zoom back out — the image can never be
 * fitted again.
 */
const MIN_ZOOM_IMAGE_RATIO = 0.5;

/**
 * Default OpenSeadragon options used by the viewer cells.
 *
 * Callers spread these and add the per-cell `element`:
 *
 * ```ts
 * const viewer = OpenSeadragon({ ...DEFAULT_VIEWER_OPTIONS, element });
 * ```
 *
 * Note `minZoomLevel` is deliberately absent: zoom-out is bounded relative
 * to home zoom via `minZoomImageRatio` so that "fit the image" is always
 * reachable regardless of the image/cell aspect ratios.
 */
export const DEFAULT_VIEWER_OPTIONS = {
  prefixUrl: '',
  showNavigationControl: false,
  animationTime: 0.3,
  minZoomImageRatio: MIN_ZOOM_IMAGE_RATIO,
  maxZoomLevel: 40,
  visibilityRatio: 0.5,
  constrainDuringPan: true,
  gestureSettingsMouse: {
    // OSD zooms in by `zoomPerClick` (2x) on a plain click by default. In an
    // annotator a click on a cell means "activate this cell" / "interact with
    // the image", not "zoom" — a stray click must not move the view. Zooming
    // in stays available deliberately via double-click and the scroll wheel.
    clickToZoom: false,
    dblClickToZoom: true,
  },
} as const satisfies OpenSeadragon.Options;
