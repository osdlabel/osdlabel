import OpenSeadragon from 'openseadragon';
import { Canvas as FabricCanvas } from 'fabric';
import type { FabricObject, TMat2D } from 'fabric';
import type { Point } from '@osdlabel/annotation';
import type { CellTransform } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import { initFabricModule } from '@osdlabel/fabric-annotations';
import { composeImageFilterCss } from './image-filters.js';
import type { ImageFilters } from './image-filters.js';
import { mirrorScreenX } from './mirror-screen-x.js';
import { computeScrollZoom } from './scroll-zoom.js';
import { observeDevicePixelRatio, syncFabricDevicePixelRatio } from './device-pixel-ratio.js';
import {
  POINTER_DOWN,
  POINTER_MOVE,
  POINTER_UP,
  POINTER_CANCEL,
  OSD_CANVAS_KEY,
  OSD_RESIZE,
  OSD_SYNC_EVENTS,
} from './constants.js';

/** Overlay interaction modes */
/**
 * How pointer input is routed and what it may act on.
 *
 * - `navigation` — OSD owns the pointer; Fabric is inert.
 * - `annotation` — Fabric owns the pointer; objects can be selected and dragged.
 * - `paint` — Fabric owns the pointer, but objects are inert. For tools that
 *   write *into* an annotation rather than transform it: a brush stroke over a
 *   shape must paint, never drag it.
 * - `customControl` — the tracker forwards raw events to a registered handler;
 *   neither OSD nor Fabric reacts.
 */
export type OverlayMode = 'navigation' | 'annotation' | 'paint' | 'customControl';

/**
 * A pointer event delivered to a {@link CustomControlHandler} while the
 * overlay is in `customControl` mode.
 */
export interface CustomControlEvent {
  /** The raw DOM pointer event. */
  readonly originalEvent: PointerEvent;
  /** Pointer position in CSS pixels relative to the viewer element. */
  readonly screenPoint: Point;
  /** Pointer position in image-space (flip-aware). */
  readonly imagePoint: Point;
}

/**
 * Receives pointer events while the overlay is in `customControl` mode. In
 * this mode neither OpenSeadragon nor the Fabric annotation layer reacts to
 * the mouse — every pointer event is forwarded here instead, letting the host
 * drive a custom viewer function (e.g. drag-to-adjust exposure).
 *
 * Handlers manage their own gesture state: `onPointerMove` fires on every
 * pointer move regardless of button state, so a drag-based handler must track
 * whether a press is in progress.
 */
export interface CustomControlHandler {
  onPointerDown?(event: CustomControlEvent): void;
  onPointerMove?(event: CustomControlEvent): void;
  onPointerUp?(event: CustomControlEvent): void;
}

/** Options for creating a FabricOverlay */
export interface OverlayOptions {
  /** Initial interactive state (default: false) */
  readonly interactive?: boolean;
  /** When true, exposes the OSD viewer on its container DOM element for E2E test access (default: false) */
  readonly testMode?: boolean;
}

/**
 * Computes the Fabric viewportTransform matrix that maps image-space to
 * screen-space for the current OSD viewport state.
 *
 * OSD's `imageToViewerElementCoordinates` accounts for zoom, pan, and rotation
 * but NOT for flip (flip is applied in the drawer's rendering pipeline).
 * We handle flip separately by mirroring the matrix horizontally.
 *
 * Exported for unit testing.
 */
export function computeViewportTransform(viewer: OpenSeadragon.Viewer): TMat2D {
  const origin = new OpenSeadragon.Point(0, 0);
  const unitX = new OpenSeadragon.Point(1, 0);
  const unitY = new OpenSeadragon.Point(0, 1);

  const screenOrigin = viewer.viewport.imageToViewerElementCoordinates(origin);
  const screenUnitX = viewer.viewport.imageToViewerElementCoordinates(unitX);
  const screenUnitY = viewer.viewport.imageToViewerElementCoordinates(unitY);

  // The vector from origin to unitX on screen encodes scaleX and skewY (rotation)
  const a = screenUnitX.x - screenOrigin.x;
  const b = screenUnitX.y - screenOrigin.y;

  // The vector from origin to unitY on screen encodes skewX and scaleY
  const c = screenUnitY.x - screenOrigin.x;
  const d = screenUnitY.y - screenOrigin.y;

  let tx = screenOrigin.x;
  const ty = screenOrigin.y;

  // OSD's imageToViewerElementCoordinates does NOT account for flip.
  // The drawer flips tiles via context2d scale(-1,1) during rendering.
  // We must compose the same horizontal flip into the Fabric viewportTransform
  // so annotations match the flipped image. The flip mirrors around x = W/2
  // where W is the container width.
  if (viewer.viewport.getFlip()) {
    const containerWidth = viewer.viewport.getContainerSize().x;
    // Horizontal flip: x' = W - x
    // Composing with affine [a, b, c, d, tx, ty]:
    //   x' = W - (a*ix + c*iy + tx) = -a*ix + -c*iy + (W - tx)
    //   y' = b*ix + d*iy + ty  (unchanged)
    return [-a, b, -c, d, containerWidth - tx, ty] as TMat2D;
  }

  return [a, b, c, d, tx, ty] as TMat2D;
}

/**
 * Convert an image-space point to screen-space, composing the same
 * horizontal-flip mirror that {@link computeViewportTransform} applies.
 *
 * OSD's `imageToViewerElementCoordinates` ignores flip (flip is applied
 * by OSD's drawer at render time). Without this composition, callers
 * that use the result as an absolute screen coordinate — e.g. the
 * `DecorationLayer` placing text divs — drift relative to the painted
 * image when only one of `flippedH` or `flippedV` is set (when both
 * are set the cell-level flip cancels: see
 * `FabricOverlay.applyViewTransform`).
 *
 * Exported for unit testing and for callers that want flip-aware
 * coordinates without a {@link FabricOverlay} instance.
 */
export function imageToScreenFlipAware(viewer: OpenSeadragon.Viewer, imagePoint: Point): Point {
  const viewport = viewer.viewport;
  const osdPoint = viewport.imageToViewerElementCoordinates(
    new OpenSeadragon.Point(imagePoint.x, imagePoint.y),
  );
  const x = mirrorScreenX(osdPoint.x, viewport.getContainerSize().x, viewport.getFlip());
  return { x, y: osdPoint.y };
}

/**
 * Inverse of {@link imageToScreenFlipAware}: convert a screen-space point
 * to image-space, undoing the horizontal-flip mirror first.
 */
export function screenToImageFlipAware(viewer: OpenSeadragon.Viewer, screenPoint: Point): Point {
  const viewport = viewer.viewport;
  const sx = mirrorScreenX(screenPoint.x, viewport.getContainerSize().x, viewport.getFlip());
  const osdPoint = viewport.viewerElementToImageCoordinates(
    new OpenSeadragon.Point(sx, screenPoint.y),
  );
  return { x: osdPoint.x, y: osdPoint.y };
}

/**
 * A Fabric.js canvas overlay synchronized with an OpenSeaDragon viewer.
 *
 * Handles event routing between OSD and Fabric using an OSD MouseTracker
 * attached to Fabric's container element. Events are forwarded to Fabric
 * as synthetic PointerEvents with a re-entrancy guard to prevent infinite
 * recursion (dispatched events bubble back to the tracker's element).
 *
 * Three interaction modes:
 * - **navigation**: OSD handles all input, Fabric is display-only.
 * - **annotation**: Fabric handles all input (select, move, draw).
 *   Ctrl+drag or Command+drag pans OSD within annotation mode.
 * - **customControl**: neither OSD nor Fabric reacts; pointer events are
 *   forwarded to a registered {@link CustomControlHandler} (e.g. drag-to-adjust
 *   exposure). Ctrl/Cmd+scroll still zooms OSD.
 */
export class FabricOverlay {
  // ── Core references ──────────────────────────────────────────────
  private readonly _viewer: OpenSeadragon.Viewer;
  private readonly _fabricCanvas: FabricCanvas;
  private readonly _canvasEl: HTMLCanvasElement;
  private readonly _overlayTracker: OpenSeadragon.MouseTracker;
  private readonly _fabricContainer: HTMLElement;

  // ── State ────────────────────────────────────────────────────────
  private _mode: OverlayMode = 'navigation';

  /** Handler invoked for pointer events while in `customControl` mode. */
  private _customControlHandler: CustomControlHandler | null = null;

  /**
   * Re-entrancy guard for forwardToFabric. When true, the synthetic
   * PointerEvent is currently being dispatched — handlers must not
   * process the bubbled-back event.
   */
  private _forwarding = false;

  /**
   * When true, the current gesture is a pan-passthrough (defined by
   * _isPanTrigger) and events should NOT be forwarded to Fabric.
   */
  private _panGestureActive = false;

  /** Callbacks fired at the end of every `sync()`. */
  private readonly _syncSubscribers = new Set<() => void>();

  /** Tears down the device-pixel-ratio media-query observer. */
  private _disposeDevicePixelRatioObserver: (() => void) | null = null;

  // ── Bound OSD event handlers (for add/removeHandler) ─────────────

  /** Repaint from settled viewport bounds. Bound to every OSD_SYNC_EVENTS entry. */
  private readonly _onSyncEvent = (): void => {
    this.sync();
  };

  /**
   * Re-measure the canvas for a new container size — without painting.
   *
   * OSD raises `resize` from inside `viewport.resize()`, before that method
   * calls `fitBounds` and before `doViewerResize` applies its follow-up
   * `panTo` / `zoomTo`. Two consequences:
   *
   * - `getContainerSize()` already reports the new size, and `setDimensions`
   *   must run here and synchronously. Deferring it (to a rAF, say) would
   *   leave Fabric a frame at the old size, stretched against the new layout.
   * - The viewport's centre and zoom are mid-update, so painting here paints a
   *   transform that is about to be superseded. The paint therefore moves to
   *   `after-resize`, which OSD raises once `fitBounds` has settled the bounds.
   *
   * It cannot move to `animation` alone: `setDimensions` clears the backing
   * store, so a resize tick where the springs did not move — and which
   * therefore raises no `animation` — would leave the overlay blank.
   *
   * Note this is a correctness tidy-up, not a fix for BL-001's visible jitter.
   * Both paints land in the same frame before the browser composites, so the
   * superseded one was never actually shown. See BACKLOG.md.
   */
  private readonly _onResize = (): void => {
    // Before setDimensions: it re-applies Fabric's retina scaling, so the
    // ratio has to be current by the time it runs.
    syncFabricDevicePixelRatio();
    const size = this._viewer.viewport.getContainerSize();
    this._fabricCanvas.setDimensions({ width: size.x, height: size.y });
  };
  private readonly _onCanvasKey = (event: { preventDefaultAction: boolean }): void => {
    event.preventDefaultAction = true;
  };

  constructor(viewer: OpenSeadragon.Viewer, options?: OverlayOptions) {
    this._viewer = viewer;

    // Ensure the `id` custom property is registered so annotation objects
    // serialize their id (and the clear filter `obj => obj.id` works). Idempotent
    // and merge-safe, so an explicit consumer call remains harmless.
    initFabricModule();

    // ── Create canvas DOM element ────────────────────────────────
    this._canvasEl = document.createElement('canvas');
    this._canvasEl.style.position = 'absolute';
    this._canvasEl.style.top = '0';
    this._canvasEl.style.left = '0';
    // CSS pointer-events stays 'none' — event routing is handled
    // entirely by the OSD MouseTracker, not CSS hit-testing.
    this._canvasEl.style.pointerEvents = 'none';

    // Insert on top of OSD's canvas element
    const osdCanvas = viewer.canvas;
    osdCanvas.appendChild(this._canvasEl);

    // Match initial dimensions
    const containerSize = viewer.viewport.getContainerSize();
    this._canvasEl.width = containerSize.x;
    this._canvasEl.height = containerSize.y;

    // ── Create Fabric canvas ─────────────────────────────────────
    this._fabricCanvas = new FabricCanvas(this._canvasEl, {
      selection: false,
      renderOnAddRemove: false,
      // skipOffscreen must be false: when the viewportTransform includes rotation
      // (90°/270°), Fabric's offscreen culling incorrectly hides objects that are
      // actually visible on the rotated canvas.
      skipOffscreen: false,
      enablePointerEvents: true,
    });

    // Fabric's getZoom() returns viewportTransform[0], which is only correct
    // for scale+translate matrices. When the viewportTransform includes rotation,
    // element [0] is cos(θ)*scale — which is 0 at 90° and negative at 180°.
    // This breaks object caching (cache canvas dimensions become 0 or negative).
    // Override to extract the actual scale as the magnitude of the first column vector.
    this._fabricCanvas.getZoom = () => {
      const vpt = this._fabricCanvas.viewportTransform;
      return Math.sqrt(vpt[0] * vpt[0] + vpt[1] * vpt[1]);
    };

    // Fabric captured window.devicePixelRatio when its config module was
    // evaluated, which may predate the page landing on this display.
    syncFabricDevicePixelRatio();
    this._fabricCanvas.setDimensions({
      width: containerSize.x,
      height: containerSize.y,
    });

    // ── Resolve Fabric's container div ───────────────────────────
    const container = this._fabricCanvas.getSelectionElement().parentElement;
    if (!container) {
      throw new Error('Fabric canvas container not found');
    }
    this._fabricContainer = container;

    // ── Create OSD MouseTracker on Fabric's container ────────────
    this._overlayTracker = this._createMouseTracker();

    // ── Attach OSD event handlers ────────────────────────────────
    for (const eventName of OSD_SYNC_EVENTS) {
      viewer.addHandler(eventName, this._onSyncEvent);
    }
    // Not a sync event — it re-measures without painting. See _onResize.
    viewer.addHandler(OSD_RESIZE, this._onResize);

    // Suppress all OSD built-in keyboard shortcuts (arrows, WASD, +/-, f, r, etc.)
    // so they don't conflict with the host application's keyboard handling.
    viewer.addHandler(OSD_CANVAS_KEY, this._onCanvasKey);

    // A display-scale change need not change the container's CSS size (drag a
    // window between a Retina and a non-Retina monitor), so no resize fires on
    // its own. Re-enter OSD's own resize path — the same remedy OSD applies to
    // itself when its window `resize` listener sees a pixelDensityRatio change
    // — which raises `resize`, where the ratio is resynced and the canvas
    // re-measured. With an unchanged container size the resulting pan/zoom is
    // a no-op.
    this._disposeDevicePixelRatioObserver = observeDevicePixelRatio(() => {
      this._viewer.forceResize();
    });

    // Initial sync if the viewer is already open
    if (viewer.isOpen()) {
      this.sync();
    }

    // Apply initial mode (or interactive shortcut)
    if (options?.interactive) {
      this.setMode('annotation');
    }

    // Expose viewer and overlay on the container element for E2E test access
    if (options?.testMode) {
      const osdCanvas = viewer.canvas as unknown as Record<string, unknown>;
      osdCanvas.__osdViewer = viewer;
      osdCanvas.__osdOverlay = this;
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  /** The Fabric.js Canvas instance */
  get canvas(): FabricCanvas {
    return this._fabricCanvas;
  }

  /**
   * The OSD container element. Companion layers (e.g. decoration text in
   * DOM) can append themselves here to be clipped/positioned together with
   * the Fabric canvas.
   */
  get overlayElement(): HTMLElement {
    return this._viewer.canvas;
  }

  /**
   * Register a callback fired at the end of every `sync()` — i.e. on every
   * OSD `animation`, `animation-finish`, `resize`, `open`, `flip`, `rotate`
   * event. Used by companion layers to reposition screen-space content.
   *
   * Returns an unsubscribe function.
   */
  onSync(callback: () => void): () => void {
    this._syncSubscribers.add(callback);
    return () => {
      this._syncSubscribers.delete(callback);
    };
  }

  /** Apply a view transform (rotation/flip) to the OpenSeadragon viewer */
  applyViewTransform(transform: CellTransform): void {
    let rotation = transform.rotation;
    // OSD horizontal flip doesn't natively do vertical flip.
    // Vertical flip = horizontal flip + 180 degree rotation.
    const isFlipped = transform.flippedH !== transform.flippedV;

    if (transform.flippedV) {
      rotation = (rotation + 180) % 360;
    }

    this._viewer.viewport.setFlip(isFlipped);
    // Use immediately=true to avoid spring animation — the rotation should
    // snap to the target so that sync() computes the correct matrix.
    this._viewer.viewport.setRotation(rotation, true);
    this.sync();
  }

  getRotation(): number {
    return this._viewer.viewport.getRotation();
  }

  getFlip(): boolean {
    return this._viewer.viewport.getFlip();
  }

  /**
   * Full-resolution size of the opened image in pixels, or `null` before the
   * image has loaded.
   *
   * Raster annotations need this: a mask is defined against the image's own
   * pixel grid, and formats like COCO RLE encode runs across the whole image,
   * so both the buffer and the exporter need the true dimensions rather than
   * anything derived from the current viewport.
   */
  getImageSize(): { width: number; height: number } | null {
    const item = this._viewer.world.getItemAt(0);
    if (!item) return null;
    const size = item.getContentSize();
    if (!size || size.x <= 0 || size.y <= 0) return null;
    return { width: size.x, height: size.y };
  }

  /**
   * Apply the tonal adjustments of a cell transform as CSS filters on OSD's
   * drawer canvas. Takes an object rather than positional args so the parameter
   * list stays self-documenting as adjustments are added; the filter string
   * itself is composed by the pure {@link composeImageFilterCss}.
   */
  applyImageFilters(filters: ImageFilters): void {
    const drawerCanvas = this._viewer.drawer.canvas as HTMLElement;
    drawerCanvas.style.filter = composeImageFilterCss(filters);
  }

  resetView(): void {
    this.applyViewTransform(DEFAULT_CELL_TRANSFORM);
  }

  /**
   * Force a re-sync of the overlay transform with the current OSD viewport.
   *
   * Uses synchronous renderAll() because this runs inside OSD's own
   * requestAnimationFrame callback. Using the async requestRenderAll()
   * would defer the Fabric paint to the *next* frame, causing a visible
   * 1-frame lag where the image has moved but annotations haven't.
   */
  sync(): void {
    const vpt = computeViewportTransform(this._viewer);
    this._fabricCanvas.setViewportTransform(vpt);
    this._fabricCanvas.renderAll();
    if (this._syncSubscribers.size > 0) {
      for (const cb of this._syncSubscribers) cb();
    }
  }

  /**
   * Register (or clear with `null`) the handler that receives pointer events
   * while the overlay is in `customControl` mode.
   */
  setCustomControlHandler(handler: CustomControlHandler | null): void {
    this._customControlHandler = handler;
  }

  /**
   * Applies the current mode's interaction rules to one object.
   *
   * `setMode` walks every object on the canvas, but objects are also added
   * *after* it runs — the annotation layer is cleared and rebuilt on every
   * state change. Those rebuilt objects have to be brought under the same rule,
   * and they cannot get it from `setMode`: it early-returns when the mode has
   * not changed, so calling it again is a no-op.
   *
   * Before this existed, `ViewerCell` set `selectable`/`evented` itself, which
   * silently undid `paint` mode the first time a stroke committed — the next
   * stroke over a shape dragged it again.
   *
   * `readOnly` marks an object that must stay inert in any mode (a
   * displayed-but-not-active context, or a decoration).
   */
  applyModeToObject(obj: FabricObject, readOnly: boolean): void {
    const interactive = this._mode === 'annotation' && !readOnly;
    obj.selectable = interactive;
    obj.evented = interactive;
  }

  /** Set the overlay interaction mode */
  setMode(mode: OverlayMode): void {
    // No-op guard: re-applying the current mode would needlessly
    // discardActiveObject() and re-walk every object, which can clobber an
    // in-progress gesture (e.g. a selection or an active custom-control drag).
    if (mode === this._mode) return;

    this._mode = mode;
    this._panGestureActive = false;

    switch (mode) {
      case 'navigation':
        // Fabric non-interactive, OSD handles all input
        this._overlayTracker.setTracking(false);
        this._fabricCanvas.selection = false;
        this._fabricCanvas.forEachObject((obj) => {
          this.applyModeToObject(obj, obj._readOnly === true);
        });
        // Deselect any active Fabric selection so controls disappear
        this._fabricCanvas.discardActiveObject();
        this._viewer.setMouseNavEnabled(true);
        break;

      case 'annotation':
        // Fabric interactive: selection, moving, and drawing.
        // OSD mouse nav is disabled.
        // Respect per-object _readOnly flag set by displayed-but-not-active contexts.
        this._overlayTracker.setTracking(true);
        this._fabricCanvas.selection = true;
        this._fabricCanvas.forEachObject((obj) => {
          this.applyModeToObject(obj, obj._readOnly === true);
        });
        this._viewer.setMouseNavEnabled(false);
        break;

      case 'paint':
        // Fabric receives pointer events so the active tool can rasterize, but
        // nothing on the canvas is selectable or draggable. Without this a
        // stroke that starts over an existing shape drags it instead of
        // painting, and `object:modified` then persists the accidental move.
        this._overlayTracker.setTracking(true);
        this._fabricCanvas.selection = false;
        this._fabricCanvas.forEachObject((obj) => {
          this.applyModeToObject(obj, obj._readOnly === true);
        });
        this._fabricCanvas.discardActiveObject();
        this._viewer.setMouseNavEnabled(false);
        break;

      case 'customControl':
        // Neither OSD nor Fabric reacts: the tracker intercepts events and
        // forwards them to the registered CustomControlHandler. Fabric is fully
        // inert and OSD mouse nav is disabled.
        this._overlayTracker.setTracking(true);
        this._fabricCanvas.selection = false;
        this._fabricCanvas.forEachObject((obj) => {
          this.applyModeToObject(obj, obj._readOnly === true);
        });
        this._fabricCanvas.discardActiveObject();
        this._viewer.setMouseNavEnabled(false);
        break;
    }

    this._fabricCanvas.renderAll();
  }

  /** Get the current overlay interaction mode */
  getMode(): OverlayMode {
    return this._mode;
  }

  /** Convert a point from screen-space to image-space. Flip-aware. */
  screenToImage(screenPoint: Point): Point {
    return screenToImageFlipAware(this._viewer, screenPoint);
  }

  /** Convert a point from image-space to screen-space. Flip-aware. */
  imageToScreen(imagePoint: Point): Point {
    return imageToScreenFlipAware(this._viewer, imagePoint);
  }

  /** Clean up all event listeners and DOM elements */
  destroy(): void {
    this._customControlHandler = null;
    this._syncSubscribers.clear();
    this._disposeDevicePixelRatioObserver?.();
    this._disposeDevicePixelRatioObserver = null;
    this._overlayTracker.destroy();
    for (const eventName of OSD_SYNC_EVENTS) {
      this._viewer.removeHandler(eventName, this._onSyncEvent);
    }
    this._viewer.removeHandler(OSD_RESIZE, this._onResize);
    this._viewer.removeHandler(OSD_CANVAS_KEY, this._onCanvasKey);
    this._fabricCanvas.dispose();
    this._canvasEl.remove();
  }

  // ── Private: Event forwarding ──────────────────────────────────

  /**
   * Dispatch a synthetic PointerEvent on Fabric's upper canvas so that
   * Fabric's internal event handling processes it normally.
   *
   * Fabric's getPointer() reads clientX/clientY from the event, so
   * we forward those directly from the original DOM event.
   *
   * A re-entrancy guard (`_forwarding`) prevents infinite recursion:
   * the synthetic event bubbles from upperCanvasEl up to the Fabric
   * container div, where the OSD MouseTracker would re-intercept it.
   */
  private _forwardToFabric(
    type: typeof POINTER_DOWN | typeof POINTER_MOVE | typeof POINTER_UP | typeof POINTER_CANCEL,
    originalEvent: PointerEvent,
  ): void {
    if (this._forwarding) return;
    this._forwarding = true;
    try {
      const upperCanvas = this._fabricCanvas.upperCanvasEl;
      const syntheticEvent = new PointerEvent(type, {
        clientX: originalEvent.clientX,
        clientY: originalEvent.clientY,
        screenX: originalEvent.screenX,
        screenY: originalEvent.screenY,
        button: originalEvent.button,
        buttons: originalEvent.buttons,
        bubbles: true,
        cancelable: true,
        pointerId: originalEvent.pointerId,
        pointerType: originalEvent.pointerType,
        isPrimary: originalEvent.isPrimary,
        ctrlKey: originalEvent.ctrlKey,
        shiftKey: originalEvent.shiftKey,
        altKey: originalEvent.altKey,
        metaKey: originalEvent.metaKey,
      });
      upperCanvas.dispatchEvent(syntheticEvent);
    } finally {
      this._forwarding = false;
    }
  }

  /**
   * Determine whether a pointerdown event should trigger an OSD pan
   * pass-through (Ctrl/Cmd+click).
   */
  private _isPanTrigger(event: PointerEvent): boolean {
    // Ctrl+left-click (or Cmd on macOS)
    if ((event.ctrlKey || event.metaKey) && event.button === 0) return true;
    return false;
  }

  /**
   * Convert a DOM event's client coordinates to CSS pixels relative to the
   * viewer element.
   *
   * Fabric's container is absolutely positioned at the origin of OSD's canvas
   * element, so its bounding rect is the viewer element's rect — which is the
   * coordinate space OSD's `viewport.pointFromPixel` and
   * `viewerElementToImageCoordinates` expect. Client coordinates are offset by
   * wherever the viewer sits in the window, and that offset changes when the
   * page enters fullscreen, scrolls, or reflows.
   */
  private _toElementPoint(originalEvent: { clientX: number; clientY: number }): Point {
    const rect = this._fabricContainer.getBoundingClientRect();
    return {
      x: originalEvent.clientX - rect.left,
      y: originalEvent.clientY - rect.top,
    };
  }

  /**
   * Build the {@link CustomControlEvent} payload from a raw DOM pointer event:
   * the screen point is element-relative CSS pixels and the image point is the
   * flip-aware image-space conversion.
   */
  private _buildCustomControlEvent(originalEvent: PointerEvent): CustomControlEvent {
    const screenPoint = this._toElementPoint(originalEvent);
    const imagePoint = this.screenToImage(screenPoint);
    return { originalEvent, screenPoint, imagePoint };
  }

  // ── Private: MouseTracker factory ──────────────────────────────

  /**
   * Create the OSD MouseTracker attached to Fabric's container element.
   *
   * OSD's innerTracker captures ALL pointer events on viewer.canvas via
   * addEventListener. Because OSD processes trackers in DOM order (child
   * before parent), our tracker fires before OSD's innerTracker. We can:
   *   1. Forward the event to Fabric as a synthetic PointerEvent
   *   2. Stop propagation to prevent OSD from also processing it
   *
   * In navigation mode the tracker is disabled (setTracking(false)),
   * so events fall through to OSD normally.
   */
  private _createMouseTracker(): OpenSeadragon.MouseTracker {
    return new OpenSeadragon.MouseTracker({
      element: this._fabricContainer,
      startDisabled: true, // Starts disabled (navigation mode)

      preProcessEventHandler: (eventInfo: OpenSeadragon.EventProcessInfo) => {
        // Re-entrancy guard: if we're dispatching a synthetic event,
        // don't process the bubbled-back copy.
        if (this._forwarding) return;

        if (this._mode === 'navigation') {
          // Should not happen (tracker is disabled), but just in case
          return;
        }

        if (this._mode === 'customControl') {
          // Block OSD and the page from every pointer event; the press/move/
          // release handlers forward them to the custom control handler.
          eventInfo.stopPropagation = true;
          eventInfo.preventDefault = true;
          return;
        }

        // ── Annotation mode ──
        const eventType = eventInfo.eventType;
        const domEvent = eventInfo.originalEvent as PointerEvent;

        if (eventType === POINTER_DOWN) {
          // Check for pan passthrough triggers
          if (this._isPanTrigger(domEvent)) {
            this._panGestureActive = true;
            // Let event propagate to OSD.
            // Temporarily enable OSD nav for this gesture.
            this._viewer.setMouseNavEnabled(true);
            return;
          }

          // Normal annotation/selection click — Fabric owns it
          this._panGestureActive = false;
          eventInfo.stopPropagation = true;
          eventInfo.preventDefault = true;
          return;
        }

        if (eventType === POINTER_MOVE) {
          if (this._panGestureActive) {
            // Part of an OSD pan gesture — let it through
            return;
          }
          eventInfo.stopPropagation = true;
          eventInfo.preventDefault = true;
          return;
        }

        if (eventType === POINTER_UP || eventType === POINTER_CANCEL) {
          if (this._panGestureActive) {
            // End of OSD pan gesture
            this._panGestureActive = false;
            this._viewer.setMouseNavEnabled(false);
            return;
          }
          eventInfo.stopPropagation = true;
          eventInfo.preventDefault = true;
          return;
        }
      },

      pressHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;

        const originalEvent = event.originalEvent as PointerEvent;
        if (this._mode === 'customControl') {
          this._customControlHandler?.onPointerDown?.(this._buildCustomControlEvent(originalEvent));
          return;
        }

        if (this._panGestureActive) return;
        this._forwardToFabric(POINTER_DOWN, originalEvent);
      },

      moveHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;

        const originalEvent = event.originalEvent as PointerEvent;
        if (this._mode === 'customControl') {
          this._customControlHandler?.onPointerMove?.(this._buildCustomControlEvent(originalEvent));
          return;
        }

        if (this._panGestureActive) return;
        this._forwardToFabric(POINTER_MOVE, originalEvent);
      },

      releaseHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;

        const originalEvent = event.originalEvent as PointerEvent;
        if (this._mode === 'customControl') {
          this._customControlHandler?.onPointerUp?.(this._buildCustomControlEvent(originalEvent));
          return;
        }

        if (this._panGestureActive) return;
        this._forwardToFabric(POINTER_UP, originalEvent);
      },

      scrollHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        // Navigation mode lets OSD handle the wheel natively.
        // Annotation and customControl both swallow page scroll and keep
        // Ctrl/Cmd+scroll as a manual OSD zoom so users never lose zoom.
        if (this._mode === 'navigation') return;

        const domEvent = event.originalEvent as WheelEvent;

        // Always prevent page scrolling while in annotation mode
        const scrollEvt = event as OpenSeadragon.MouseTrackerEvent & { preventDefault: boolean };
        scrollEvt.preventDefault = true;

        if (domEvent.ctrlKey || domEvent.metaKey) {
          // Ctrl/Cmd+scroll → manually zoom OSD.
          // OSD's own scroll-zoom is disabled (setMouseNavEnabled(false)),
          // so we call viewport.zoomBy() directly.
          const viewport = this._viewer.viewport;
          const command = computeScrollZoom({
            deltaY: domEvent.deltaY,
            position: this._toElementPoint(domEvent),
            containerWidth: viewport.getContainerSize().x,
            flipped: viewport.getFlip(),
          });
          if (!command) return;

          // Zoom around the pointer position (in viewport coordinates)
          viewport.zoomBy(
            command.factor,
            viewport.pointFromPixel(
              new OpenSeadragon.Point(command.anchorPixel.x, command.anchorPixel.y),
              true, // current = true (use current animated position)
            ),
          );
          viewport.applyConstraints();
        }
      },
    });
  }
}
