import OpenSeadragon from 'openseadragon';
import { Canvas as FabricCanvas } from 'fabric';
import type { TMat2D } from 'fabric';
import type { Point } from '@osdlabel/annotation';
import type { CellTransform } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import '@osdlabel/fabric-annotations';
import {
  POINTER_DOWN,
  POINTER_MOVE,
  POINTER_UP,
  POINTER_CANCEL,
  OSD_ANIMATION,
  OSD_ANIMATION_FINISH,
  OSD_RESIZE,
  OSD_OPEN,
} from './constants.js';

/** Overlay interaction modes */
export type OverlayMode = 'navigation' | 'annotation';

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
 * A Fabric.js canvas overlay synchronized with an OpenSeaDragon viewer.
 *
 * Handles event routing between OSD and Fabric using an OSD MouseTracker
 * attached to Fabric's container element. Events are forwarded to Fabric
 * as synthetic PointerEvents with a re-entrancy guard to prevent infinite
 * recursion (dispatched events bubble back to the tracker's element).
 *
 * Two interaction modes:
 * - **navigation**: OSD handles all input, Fabric is display-only.
 * - **annotation**: Fabric handles all input (select, move, draw).
 *   Ctrl+drag or Command+drag pans OSD within annotation mode.
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

  // ── Bound OSD event handlers (for add/removeHandler) ─────────────
  private readonly _onAnimation = (): void => {
    this.sync();
  };
  private readonly _onAnimationFinish = (): void => {
    this.sync();
  };
  private readonly _onOpen = (): void => {
    this.sync();
  };
  private readonly _onResize = (): void => {
    const size = this._viewer.viewport.getContainerSize();
    this._fabricCanvas.setDimensions({ width: size.x, height: size.y });
    this.sync();
  };
  private readonly _onFlip = (): void => {
    this.sync();
  };
  private readonly _onRotate = (): void => {
    this.sync();
  };
  private readonly _onCanvasKey = (event: { preventDefaultAction: boolean }): void => {
    event.preventDefaultAction = true;
  };

  constructor(viewer: OpenSeadragon.Viewer, options?: OverlayOptions) {
    this._viewer = viewer;

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
    viewer.addHandler(OSD_ANIMATION, this._onAnimation);
    viewer.addHandler(OSD_ANIMATION_FINISH, this._onAnimationFinish);
    viewer.addHandler(OSD_RESIZE, this._onResize);
    viewer.addHandler(OSD_OPEN, this._onOpen);
    viewer.addHandler('flip', this._onFlip);
    viewer.addHandler('rotate', this._onRotate);

    // Suppress all OSD built-in keyboard shortcuts (arrows, WASD, +/-, f, r, etc.)
    // so they don't conflict with the host application's keyboard handling.
    viewer.addHandler('canvas-key', this._onCanvasKey);

    // Initial sync if the viewer is already open
    if (viewer.isOpen()) {
      this.sync();
    }

    // Apply initial mode (or interactive shortcut)
    if (options?.interactive) {
      this.setMode('annotation');
    }

    // Expose viewer on its container element for E2E test access
    if (options?.testMode) {
      const osdCanvas = viewer.canvas as unknown as Record<string, unknown>;
      osdCanvas.__osdViewer = viewer;
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  /** The Fabric.js Canvas instance */
  get canvas(): FabricCanvas {
    return this._fabricCanvas;
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

  applyImageFilters(exposure: number, inverted: boolean): void {
    const drawerCanvas = this._viewer.drawer.canvas as HTMLElement;
    const parts: string[] = [];
    if (exposure !== 0) {
      parts.push(`brightness(${1 + exposure})`);
    }
    if (inverted) {
      parts.push('invert(1)');
    }
    drawerCanvas.style.filter = parts.length > 0 ? parts.join(' ') : '';
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
  }

  /** Set the overlay interaction mode */
  setMode(mode: OverlayMode): void {
    this._mode = mode;
    this._panGestureActive = false;

    switch (mode) {
      case 'navigation':
        // Fabric non-interactive, OSD handles all input
        this._overlayTracker.setTracking(false);
        this._fabricCanvas.selection = false;
        this._fabricCanvas.forEachObject((obj) => {
          obj.selectable = false;
          obj.evented = false;
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
          const readOnly = obj._readOnly === true;
          obj.selectable = !readOnly;
          obj.evented = !readOnly;
        });
        this._viewer.setMouseNavEnabled(false);
        break;
    }

    this._fabricCanvas.renderAll();
  }

  /** Get the current overlay interaction mode */
  getMode(): OverlayMode {
    return this._mode;
  }

  /** Convert a point from screen-space to image-space */
  screenToImage(screenPoint: Point): Point {
    const osdPoint = this._viewer.viewport.viewerElementToImageCoordinates(
      new OpenSeadragon.Point(screenPoint.x, screenPoint.y),
    );
    return { x: osdPoint.x, y: osdPoint.y };
  }

  /** Convert a point from image-space to screen-space */
  imageToScreen(imagePoint: Point): Point {
    const osdPoint = this._viewer.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(imagePoint.x, imagePoint.y),
    );
    return { x: osdPoint.x, y: osdPoint.y };
  }

  /** Clean up all event listeners and DOM elements */
  destroy(): void {
    this._overlayTracker.destroy();
    this._viewer.removeHandler(OSD_ANIMATION, this._onAnimation);
    this._viewer.removeHandler(OSD_ANIMATION_FINISH, this._onAnimationFinish);
    this._viewer.removeHandler(OSD_RESIZE, this._onResize);
    this._viewer.removeHandler(OSD_OPEN, this._onOpen);
    this._viewer.removeHandler('flip', this._onFlip);
    this._viewer.removeHandler('rotate', this._onRotate);
    this._viewer.removeHandler('canvas-key', this._onCanvasKey);
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
        if (this._panGestureActive) return;

        const originalEvent = event.originalEvent as PointerEvent;
        this._forwardToFabric(POINTER_DOWN, originalEvent);
      },

      moveHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;
        if (this._panGestureActive) return;

        const originalEvent = event.originalEvent as PointerEvent;
        this._forwardToFabric(POINTER_MOVE, originalEvent);
      },

      releaseHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;
        if (this._panGestureActive) return;

        const originalEvent = event.originalEvent as PointerEvent;
        this._forwardToFabric(POINTER_UP, originalEvent);
      },

      scrollHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._mode !== 'annotation') return;

        const domEvent = event.originalEvent as WheelEvent;

        // Always prevent page scrolling while in annotation mode
        const scrollEvt = event as OpenSeadragon.MouseTrackerEvent & { preventDefault: boolean };
        scrollEvt.preventDefault = true;

        if (domEvent.ctrlKey || domEvent.metaKey) {
          // Ctrl/Cmd+scroll → manually zoom OSD.
          // OSD's own scroll-zoom is disabled (setMouseNavEnabled(false)),
          // so we call viewport.zoomBy() directly.
          const delta = -domEvent.deltaY;
          const zoomFactor = Math.pow(1.2, delta > 0 ? 1 : -1);

          // Zoom around the pointer position (in viewport coordinates)
          const viewerPos = this._viewer.viewport.pointFromPixel(
            new OpenSeadragon.Point(domEvent.clientX, domEvent.clientY),
            true, // current = true (use current animated position)
          );
          this._viewer.viewport.zoomBy(zoomFactor, viewerPos);
          this._viewer.viewport.applyConstraints();
        }
      },
    });
  }
}
