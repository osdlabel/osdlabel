/** Pointer event types forwarded to Fabric */
export const POINTER_DOWN = 'pointerdown' as const;
export const POINTER_MOVE = 'pointermove' as const;
export const POINTER_UP = 'pointerup' as const;
export const POINTER_CANCEL = 'pointercancel' as const;

/** OpenSeadragon viewer event types */
export const OSD_ANIMATION = 'animation' as const;
export const OSD_ANIMATION_FINISH = 'animation-finish' as const;
export const OSD_RESIZE = 'resize' as const;
export const OSD_AFTER_RESIZE = 'after-resize' as const;
export const OSD_OPEN = 'open' as const;
export const OSD_FLIP = 'flip' as const;
export const OSD_ROTATE = 'rotate' as const;
export const OSD_CANVAS_KEY = 'canvas-key' as const;

/**
 * The OSD events after which the overlay repaints from the viewport's settled
 * bounds.
 *
 * `resize` is deliberately absent. OSD raises it from inside
 * `viewport.resize()`, *before* that method calls `fitBounds` and before
 * `doViewerResize` applies the follow-up `panTo` / `zoomTo`. The container size
 * is already updated at that point — so the canvas must be re-measured there —
 * but the viewport's centre and zoom are mid-update, so a paint there is
 * immediately superseded. `after-resize` fires once `fitBounds` has settled
 * those bounds. See `FabricOverlay._onResize`.
 */
export const OSD_SYNC_EVENTS = [
  OSD_ANIMATION,
  OSD_ANIMATION_FINISH,
  OSD_AFTER_RESIZE,
  OSD_OPEN,
  OSD_FLIP,
  OSD_ROTATE,
] as const;
