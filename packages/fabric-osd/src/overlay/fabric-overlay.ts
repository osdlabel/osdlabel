import OpenSeadragon from 'openseadragon';
import { Canvas as FabricCanvas, Point as FabricPoint, Polyline } from 'fabric';
import type { FabricObject, TMat2D, Transform } from 'fabric';
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

/**
 * Called on a double click in annotation mode, with the raw DOM event and the
 * flip-aware image-space point it landed on.
 *
 * The argument order matches `AnnotationTool.onPointerDown(event, imagePoint)`
 * so a tool method can be registered directly.
 */
export type DoubleClickCallback = (
  event: PointerEvent,
  imagePoint: Point,
  /**
   * The press sequence numbers of the two presses that formed this pair, in
   * order, so a tool that accumulates on press can identify the vertices this
   * gesture created. The overlay always supplies them — both presses are
   * recorded before either release can qualify — so the parameter is optional
   * only to keep existing two-parameter callbacks assignable.
   */
  pressSeqs?: readonly [number, number],
) => void;

/**
 * Called when the press in progress in annotation or paint mode is cancelled.
 * Usually that is the platform's `pointercancel` for the pointer that
 * pressed, sent when the OS or the browser takes a touch or pen contact away
 * mid-gesture (an edge swipe, palm rejection, a system dialog, an orientation
 * change). The overlay also cancels a touch press itself when a pen or a mouse
 * presses while it is held, since a touch never wins over either: the touch
 * was a hand at rest, and the event is then that pointer's `pointerdown`. It
 * receives that raw DOM event and the sequence of the press it took away (see
 * {@link FabricOverlay.pressSeqOf}).
 *
 * The overlay has already put the object Fabric was transforming back as the
 * press found it. What the press began elsewhere is the subscriber's to undo:
 * a tool drops its preview, a polyline the vertex that press placed. The
 * overlay then ends Fabric's gesture with a forwarded release that commits
 * nothing, and that release reaches the tool's `onPointerUp`, so the tool must
 * have dropped its preview by then; subscribers are called first for that
 * reason. That release is also marked: {@link FabricOverlay.isCancelledRelease}
 * is true for it.
 */
export type PointerCancelCallback = (event: PointerEvent, pressSeq: number) => void;

/** The fields {@link FabricOverlay} copies onto each synthetic event it forwards to Fabric. */
type ForwardedPointerFields = Pick<
  PointerEvent,
  | 'clientX'
  | 'clientY'
  | 'screenX'
  | 'screenY'
  | 'button'
  | 'buttons'
  | 'pointerId'
  | 'pointerType'
  | 'isPrimary'
  | 'ctrlKey'
  | 'shiftKey'
  | 'altKey'
  | 'metaKey'
>;

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
 * recursion (a dispatched event that bubbles reaches the tracker's element).
 * The press is dispatched non-bubbling; see `_forwardToFabric`.
 *
 * Four interaction modes:
 * - **navigation**: OSD handles all input, Fabric is display-only.
 * - **annotation**: Fabric handles all input (select, move, draw).
 *   Ctrl+drag or Command+drag pans OSD within annotation mode. Fabric's group
 *   selection (`canvas.selection`: drag-box and Shift+click) is turned off on
 *   every entry to annotation mode; the select tool turns it on while it is
 *   active. A host driving the overlay without the library's tools sets it
 *   itself after each `setMode('annotation')`. A gesture belongs to the
 *   pointer that pressed: its lift ends it, though another finger is still
 *   down, and a pointer that goes down meanwhile starts nothing until it lifts
 *   and presses again. There is no two-finger gesture. The one exception: a
 *   touch never wins over a pen or a mouse. When either presses while a touch
 *   press is held, the touch is taken for a hand at rest, so its press is
 *   cancelled and the new one goes through.
 * - **paint**: as annotation, but every object is inert and group selection
 *   stays off, for a tool that paints into an annotation (the segmentation
 *   brush). A second finger landing mid-stroke ends the stroke there.
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

  /** Callbacks fired on a double click in annotation mode. */
  private readonly _doubleClickSubscribers = new Set<DoubleClickCallback>();

  /** Callbacks fired when the platform cancels the press in progress. */
  private readonly _pointerCancelSubscribers = new Set<PointerCancelCallback>();

  /**
   * The press in progress, so a release can be qualified as a click and a
   * cancel can be undone. `event` is the press as the browser delivered it,
   * which the release that ends a cancelled gesture is built from.
   *
   * While it is set, only its pointer reaches Fabric: see `_heldPointers`.
   */
  private _pendingPress: {
    time: number;
    x: number;
    y: number;
    pointerId: number;
    pointerType: string;
    seq: number;
    event: PointerEvent;
  } | null = null;

  /**
   * Pointers that went down on the overlay as a second pointer (see
   * `_isSecondPointer`): a second finger, a finger (a resting palm) next to a
   * pen or mouse, or a pen and a mouse next to each other. A touch press that
   * a pen's or mouse's press then takes over joins them too. Nothing a held
   * pointer does reaches Fabric, its lift included, so it starts nothing until
   * it lifts and presses again; nor OSD's gesture handling (`preventGesture`).
   *
   * An entry leaves on the pointer's `pointerup` or `pointercancel`, and, in
   * case that went unseen, on its next press or on a move with no button
   * down, either of which means it lifted. `setMode` clears them all.
   */
  private readonly _heldPointers = new Set<number>();

  /**
   * Releases `preProcessEventHandler` has already dealt with: the lift of the
   * pointer that pressed, which it forwards itself, and a held pointer's lift,
   * which it drops. OSD may report the same `pointerup` to `releaseHandler`
   * afterwards, which must then do nothing. Keyed on the DOM event.
   */
  private readonly _handledReleases = new WeakSet<PointerEvent>();

  /**
   * The points of the polyline or polygon a Fabric transform started on, as
   * they were when Fabric set the transform up, so a cancelled press can
   * restore them. Fabric's own `transform.original` records only the object's
   * placement (position, scale, skew, angle, flip), and a vertex drag moves
   * points; the vertex editor's insert handle even adds one on the press,
   * after the transform is set up and before any move.
   */
  private _transformPoints: {
    readonly transform: Transform;
    readonly points: readonly { readonly x: number; readonly y: number }[];
  } | null = null;

  /** The previous completed click, for double-click detection. */
  private _lastClick: {
    time: number;
    x: number;
    y: number;
    pointerType: string;
    seq: number;
  } | null = null;

  /**
   * Monotonic press counter, and the map from each forwarded `pointerdown` to
   * the press that produced it.
   *
   * Tools identify a double click's own vertices by these numbers rather than
   * by measuring screen distance (#176). The map is keyed on the *synthetic*
   * event — the one a tool actually receives — and populated only for presses,
   * so a lookup for any other event is `undefined`, which callers must read as
   * "not a tracked press" rather than as a sequence.
   */
  private _pressSeq = 0;
  private readonly _pressSeqByEvent = new WeakMap<PointerEvent, number>();
  /** Releases forwarded on behalf of a cancelled pointer; see `isCancelledRelease`. */
  private readonly _cancelledReleases = new WeakSet<PointerEvent>();

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

  /** Record the points a transform starts from; see `_transformPoints`. */
  private readonly _onBeforeTransform = ({ transform }: { transform: Transform }): void => {
    const target = transform.target;
    this._transformPoints =
      target instanceof Polyline
        ? { transform, points: target.points.map(({ x, y }) => ({ x, y })) }
        : null;
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

    // Fires as Fabric sets a transform up on a press, before any control's
    // mouseDownHandler runs; see `_transformPoints`.
    this._fabricCanvas.on('before:transform', this._onBeforeTransform);

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

  /**
   * The press that produced a forwarded `pointerdown`, or `undefined` if this
   * event is not one the overlay forwarded as a press.
   *
   * Pure: the same event always yields the same answer, so a caller never has
   * to reason about when it asks. `undefined` means "not a tracked press" —
   * never a stale number — which is the correct reading for a move, a release,
   * and for the synthetic events tests construct by hand.
   */
  pressSeqOf(event: PointerEvent): number | undefined {
    return this._pressSeqByEvent.get(event);
  }

  /**
   * Whether a forwarded `pointerup` ends a press that was cancelled, rather
   * than one the user lifted.
   *
   * Fabric has no `pointercancel`, so the overlay ends a cancelled press with
   * a release of its own, after it has told {@link onPointerCancel}
   * subscribers (which is where the framework hooks call the active tool's
   * `onPointerCancel`); this marks that release, so a tool can also tell the
   * two apart on the release itself. The browser cancels a pointer when it
   * decides the input was not meant for the page — palm rejection above all,
   * and system gestures — so a tool that commits on release should discard
   * instead. Keyed on the synthetic event, as {@link pressSeqOf} is.
   */
  isCancelledRelease(event: PointerEvent): boolean {
    return this._cancelledReleases.has(event);
  }

  /**
   * Register a callback fired when a double click lands on the overlay in
   * annotation mode. Returns an unsubscribe function.
   *
   * The gesture does not come from Fabric, and cannot: see the "Double clicks"
   * section of the OSD-Fabric integration guide (issue #168).
   *
   * Subscribing resets any pending pairing, so a click made before this call
   * cannot pair with the first after it — the hooks resubscribe whenever their
   * effect re-runs, of which a tool change is the case `setMode` does not see.
   */
  onDoubleClick(callback: DoubleClickCallback): () => void {
    this._lastClick = null;
    this._doubleClickSubscribers.add(callback);
    return () => {
      this._doubleClickSubscribers.delete(callback);
    };
  }

  /**
   * Register a callback fired when the press in progress in annotation or
   * paint mode is cancelled (`pointercancel`, or a touch press that a pen's or
   * mouse's press took over). Returns an unsubscribe function.
   *
   * See {@link PointerCancelCallback} for what the overlay has already undone
   * when it is called, and what is left to the subscriber. The framework hooks
   * route it to the active tool's optional `onPointerCancel`.
   */
  onPointerCancel(callback: PointerCancelCallback): () => void {
    this._pointerCancelSubscribers.add(callback);
    return () => {
      this._pointerCancelSubscribers.delete(callback);
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
    // A click from the previous mode must not pair with one from the next.
    this._pendingPress = null;
    this._lastClick = null;
    // The tracker stops listening in navigation mode, so a held pointer's
    // lift could go unseen.
    this._heldPointers.clear();

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
        // Group selection (drag-box, Shift+click) stays off: the select tool
        // turns it on while it is active. On for every tool, a drawing drag
        // across shapes also selected them as a group.
        this._overlayTracker.setTracking(true);
        this._fabricCanvas.selection = false;
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
    this._doubleClickSubscribers.clear();
    this._pointerCancelSubscribers.clear();
    this._pendingPress = null;
    this._lastClick = null;
    this._heldPointers.clear();
    this._transformPoints = null;
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
   * A re-entrancy guard (`_forwarding`) prevents infinite recursion: a
   * synthetic event that bubbles from upperCanvasEl reaches the Fabric
   * container div, where the OSD MouseTracker would re-intercept it.
   *
   * **The invariant: the press does not bubble, and the release does not
   * pass through the tracker's element.** A bubbled press reaches OSD's
   * contact bookkeeping, which the guard cannot prevent; so would a bubbled
   * release, whose `removeContact` the guard cannot prevent either. That was
   * harmless while every release was forwarded from `releaseHandler`, after
   * OSD had already removed the contact, but `_releasePress`, `_cancelPress`
   * and `_endPendingPress` forward one from `preProcessEventHandler`,
   * *before* OSD processes the real event: a bubbled copy then removed a live
   * contact, and the second finger that revealed the loss was reported as a
   * fresh press. So the release is dispatched on the container's parent
   * instead. Fabric binds `pointerup` on
   * the document, so it still arrives; OSD's own tracker on that element is
   * disabled in every mode that forwards. The move keeps bubbling from the
   * upper canvas: it only updates a position OSD already has.
   *
   * The derivation — why the guard is insufficient and why the bug was
   * touch-only — is in the "Forwarding to Fabric" section of
   * `apps/docs/src/content/docs/guides/osd-fabric-integration.md`. See #175.
   */
  private _forwardToFabric(
    type: typeof POINTER_DOWN | typeof POINTER_MOVE | typeof POINTER_UP | typeof POINTER_CANCEL,
    originalEvent: ForwardedPointerFields,
    /**
     * The sequence to stamp on the dispatched event, passed by the one caller
     * that has just produced it. Taking it as a parameter rather than reading
     * `_pendingPress` means there is no ordering between this method and
     * `_recordPress` to get wrong: a caller that does not supply one stamps
     * nothing, instead of silently stamping the *previous* press's number.
     */
    pressSeq?: number,
    /**
     * Identity to stamp instead of `originalEvent`'s, for a release forwarded
     * on behalf of a pointer other than the one that produced the event — see
     * `_endPendingPress`. Fabric only acts on the primary pointer, so a
     * release that must reach it has to carry that pointer's id.
     */
    asPointer?: {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
    },
    /** Marks the release as ending a cancelled press; see `isCancelledRelease`. */
    cancelled = false,
  ): void {
    if (this._forwarding) return;
    this._forwarding = true;
    try {
      const upperCanvas = this._fabricCanvas.upperCanvasEl;
      // Withholding the press costs Fabric nothing: it binds `pointerdown` on
      // the upper canvas itself, so the event arrives AT_TARGET. See the
      // doc comment above for why the move must still bubble and the release
      // must start above the tracker's element.
      const bubbles = type !== POINTER_DOWN;
      const target =
        type === POINTER_UP ? (this._fabricContainer.parentElement ?? upperCanvas) : upperCanvas;
      const syntheticEvent = new PointerEvent(type, {
        clientX: originalEvent.clientX,
        clientY: originalEvent.clientY,
        screenX: originalEvent.screenX,
        screenY: originalEvent.screenY,
        // A release always reports the primary button up: Fabric drops a
        // `pointerup` with any other `button`, and the event that reveals a
        // lost release (a cancel, a chord) need not carry 0 itself.
        button: type === POINTER_UP ? 0 : originalEvent.button,
        buttons: type === POINTER_UP ? 0 : originalEvent.buttons,
        bubbles,
        cancelable: true,
        pointerId: asPointer?.pointerId ?? originalEvent.pointerId,
        pointerType: asPointer?.pointerType ?? originalEvent.pointerType,
        isPrimary: asPointer?.isPrimary ?? originalEvent.isPrimary,
        ctrlKey: originalEvent.ctrlKey,
        shiftKey: originalEvent.shiftKey,
        altKey: originalEvent.altKey,
        metaKey: originalEvent.metaKey,
      });
      // Keyed on the synthetic event because that is the one the tool
      // receives; keying `originalEvent` would make every lookup undefined.
      if (pressSeq !== undefined) {
        this._pressSeqByEvent.set(syntheticEvent, pressSeq);
      }
      if (cancelled) this._cancelledReleases.add(syntheticEvent);
      target.dispatchEvent(syntheticEvent);
    } finally {
      this._forwarding = false;
    }
  }

  /**
   * Ends, and commits, the forwarded press on an event other than its own
   * pointer's release.
   *
   * Two inputs end a press that way: a second finger landing mid-stroke in
   * paint mode, which would otherwise turn the stroke into a pinch that goes
   * on painting; and a chord, whose final `pointerup` names a button other
   * than the primary one, so no release is ever reported for the press.
   * Fabric drops every non-primary pointer, so what it can act on is a
   * `pointerup` carrying the press's own pointer id — forwarded here, with the
   * position of whatever event revealed the end.
   *
   * The lift of the pointer that pressed goes through `_releasePress`, and a
   * cancel through `_cancelPress`, which reverts rather than commits.
   *
   * Not a click: the pending press is consumed without pairing it, so it
   * cannot read as the first half of a double click.
   */
  private _endPendingPress(revealedBy: PointerEvent): void {
    const press = this._pendingPress;
    if (!press) return;
    this._pendingPress = null;
    this._lastClick = null;
    this._transformPoints = null;
    this._forwardToFabric(POINTER_UP, revealedBy, undefined, {
      pointerId: press.pointerId,
      pointerType: press.pointerType,
      isPrimary: true,
    });
  }

  /**
   * Hold a pointer going down (see `_heldPointers`): nothing of it reaches
   * Fabric, and `preventGesture` keeps OSD from capturing it, from calling its
   * press and release handlers for it, and from starting a pinch with it.
   */
  private _hold(eventInfo: OpenSeadragon.EventProcessInfo, domEvent: PointerEvent): void {
    this._heldPointers.add(domEvent.pointerId);
    eventInfo.preventGesture = true;
    eventInfo.stopPropagation = true;
    eventInfo.preventDefault = true;
  }

  /** Remember where and when a press started, for `_detectDoubleClick`. */
  private _recordPress(originalEvent: PointerEvent): number {
    const { x, y } = this._toElementPoint(originalEvent);
    this._pendingPress = {
      time: originalEvent.timeStamp,
      x,
      y,
      pointerId: originalEvent.pointerId,
      pointerType: originalEvent.pointerType,
      seq: ++this._pressSeq,
      event: originalEvent,
    };
    return this._pendingPress.seq;
  }

  /**
   * Whether a pointer going down now is a second pointer, which the overlay
   * holds (`_heldPointers`) rather than letting it start a gesture:
   *
   * - one the platform does not call primary: a finger put down while another
   *   touches the screen. Fabric ignores such a pointer's events anyway, but
   *   OSD can still report its press (see `_releasePress`);
   * - any pointer of another type while a press is in progress: a finger (a
   *   resting palm, say) next to a pen or mouse, or a pen and a mouse next to
   *   each other. OSD counts each type's contacts apart, so it reports that
   *   press, and the platform calls it primary, so Fabric would take it for
   *   the gesture's own pointer.
   *
   * A pen or mouse pressing beside a touch press is not one: a touch never
   * wins over a pen or a mouse, so `preProcessEventHandler` has cancelled the
   * touch's press before asking. A pointer of the press's own type that the
   * platform calls primary is not held either: it can only be pressing
   * because the press's pointer has lifted, so it starts a gesture of its own,
   * as it always has.
   */
  private _isSecondPointer(event: PointerEvent): boolean {
    if (event.isPrimary === false) return true;
    const press = this._pendingPress;
    return press !== null && event.pointerType !== press.event.pointerType;
  }

  /**
   * Whether a move goes to Fabric. While a press is in progress, only its own
   * pointer's moves do: a mouse hovering beside a finger's drag would
   * otherwise carry the shape after the mouse. (Were the mouse to press, it
   * would take the gesture over instead: a touch never wins over a mouse.)
   * Otherwise every move does (a mouse's hover sets Fabric's cursor and the
   * polyline tool's rubber band), except a held pointer's.
   */
  private _movesFabric(event: PointerEvent): boolean {
    const press = this._pendingPress;
    if (press !== null) return event.pointerId === press.pointerId;
    if (!this._heldPointers.has(event.pointerId)) return true;
    if (event.buttons !== 0) return false;
    // No button down, so the held pointer has lifted, unseen.
    this._heldPointers.delete(event.pointerId);
    return true;
  }

  /**
   * End a gesture with its release: forward it to Fabric, which commits what
   * the gesture did (`object:modified`, a drawing tool's `mouse:up`), and
   * qualify it as a click.
   *
   * Called from `preProcessEventHandler` for the lift of the pointer that
   * pressed, rather than waiting for OSD's `releaseHandler`, which OSD calls
   * only when the last contact of a pointer type lifts. When a second finger
   * is still down it never comes, and Fabric's transform used to stay open:
   * the canvas showed the edit, the host's state kept the old shape, and the
   * next movement of any pointer carried the shape on. The forwarded release
   * is dispatched above the tracker's element (see `_forwardToFabric`), so it
   * leaves OSD's contact count alone: OSD removes the contact itself when it
   * processes the real `pointerup` next.
   *
   * The release is marked handled, so `releaseHandler` skips it when OSD
   * reports it too, as it does for a lone contact.
   */
  private _releasePress(originalEvent: PointerEvent): void {
    this._handledReleases.add(originalEvent);
    this._forwardToFabric(POINTER_UP, originalEvent);
    // The transform has ended; its recorded points are no use to anyone.
    this._transformPoints = null;
    this._detectDoubleClick(originalEvent);
  }

  /**
   * Undo the press in progress, which the platform has cancelled.
   *
   * OSD answers `pointercancel` with `stopTrackingPointer` and never calls
   * `releaseHandler`, and Fabric has no `pointercancel` handling, so without
   * this nothing ends Fabric's gesture: its transform stays open, the object
   * stays where the pointer left it while the host's state keeps it where it
   * was, the document-level listeners Fabric added on the press keep running,
   * so the next movement of any pointer carries the object on, and the next
   * release anywhere commits it there.
   *
   * Cancel means revert, the platform's meaning for `pointercancel`:
   *
   * 1. Put the object Fabric was transforming back as the press found it, and
   *    clear `actionPerformed`, so Fabric fires no `object:modified`.
   * 2. Tell subscribers, so the active tool drops what the press began.
   * 3. End Fabric's gesture with a release, which runs Fabric's own cleanup
   *    (the open transform, the document listeners, the rubber band) and
   *    commits nothing.
   *
   * The press's other effects stand, as focus does after a cancelled press:
   * an object it selected stays selected. Its pairing state is dropped, so the
   * clicks either side of a cancelled press cannot pair into a double click.
   *
   * Only a cancel of the pointer that pressed counts, with one exception:
   * a touch never wins over a pen or a mouse, so when either presses while a
   * touch press is held, `preProcessEventHandler` cancels the touch's press
   * with that `pointerdown` as `cancelEvent` (`revealedByOtherPointer`). The
   * platform usually cancels a palm itself, but not always before the pen
   * lands, and has no cause to cancel a finger left on a touchscreen beside
   * the mouse.
   * `lostpointercapture` is not handled separately: the browser sends it
   * after the `pointerup` or `pointercancel` that ends a press, and in this
   * overlay nothing releases capture mid-press.
   *
   * Runs from `preProcessEventHandler`, before OSD's own `updatePointerCancel`
   * stops tracking the pointer and removes its contact. The release
   * dispatched here starts above the tracker's element (see
   * `_forwardToFabric`), so OSD does not count it.
   */
  private _cancelPress(cancelEvent: PointerEvent, revealedByOtherPointer = false): void {
    const press = this._pendingPress;
    if (!press || (!revealedByOtherPointer && press.pointerId !== cancelEvent.pointerId)) return;
    this._pendingPress = null;
    this._lastClick = null;

    const transform = this._fabricCanvas._currentTransform;
    if (transform) this._revertTransform(transform);
    this._transformPoints = null;

    try {
      // Snapshot + membership check, as for double clicks.
      for (const callback of [...this._pointerCancelSubscribers]) {
        if (!this._pointerCancelSubscribers.has(callback)) continue;
        callback(cancelEvent, press.seq);
      }
    } finally {
      // Place the object's controls for the shape as it now is: after the
      // subscribers, who may have rebuilt them for the restored points, and
      // before the release, which hit-tests them.
      transform?.target.setCoords();
      // Even if a subscriber throws: left open, the gesture is what moves the
      // object on the next movement of any pointer.
      this._endCancelledGesture(press.event);
    }
  }

  /**
   * Put a transform's object back as the press found it, and mark the
   * transform as having done nothing, so ending it fires no `object:modified`.
   *
   * Fabric's `transform.original` holds the placement at the press. Its
   * `originX` / `originY` are the transform's anchor (the corner opposite a
   * dragged scale handle, say), not the object's origin, so they are not
   * restored. Points come from `_transformPoints`.
   */
  private _revertTransform(transform: Transform): void {
    const { target, original } = transform;
    const recorded = this._transformPoints;
    if (
      recorded?.transform === transform &&
      target instanceof Polyline &&
      !samePoints(target.points, recorded.points)
    ) {
      // Fresh, mutable points: Fabric's poly controls edit them in place.
      target.set({ points: recorded.points.map(({ x, y }) => new FabricPoint(x, y)) });
      target.setDimensions();
    }
    target.set({
      left: original.left,
      top: original.top,
      scaleX: original.scaleX,
      scaleY: original.scaleY,
      skewX: original.skewX,
      skewY: original.skewY,
      angle: original.angle,
      flipX: original.flipX,
      flipY: original.flipY,
    });
    // No `setCoords()` here: the object's controls may still be the ones the
    // press built for points just taken back (the vertex editor's insert
    // handle rebuilds them for its new vertex), and placing them would read
    // past the end of `points`. Subscribers rebuild them; `_cancelPress`
    // places them after that.
    transform.actionPerformed = false;
  }

  /**
   * End Fabric's gesture for a cancelled press, as a release would, without
   * letting the release do what a release does.
   *
   * The release is built from the press, not copied from the cancel: Chrome
   * sends `pointercancel` with `button` -1, which Fabric's `__onMouseUp` takes
   * for a right or middle button and returns on before ending anything. At the
   * press's position it lands on what the press landed on, now that the
   * object is back there, so it reaches no other control's mouse-up handler.
   * Fabric applies a rubber-band selection on release unless `selection` is
   * off, so it is off for the duration.
   *
   * The release is marked cancelled (`isCancelledRelease`), for a tool that
   * tells a cancel from a lift on the release rather than through
   * `onPointerCancel`.
   */
  private _endCancelledGesture(press: PointerEvent): void {
    const canvas = this._fabricCanvas;
    const selection = canvas.selection;
    canvas.selection = false;
    try {
      this._forwardToFabric(
        POINTER_UP,
        {
          clientX: press.clientX,
          clientY: press.clientY,
          screenX: press.screenX,
          screenY: press.screenY,
          button: 0,
          buttons: 0,
          pointerId: press.pointerId,
          pointerType: press.pointerType,
          isPrimary: press.isPrimary,
          ctrlKey: press.ctrlKey,
          shiftKey: press.shiftKey,
          altKey: press.altKey,
          metaKey: press.metaKey,
        },
        undefined,
        undefined,
        true,
      );
    } finally {
      canvas.selection = selection;
    }
    canvas.requestRenderAll();
  }

  /**
   * Qualify a release as a click, pair it with the previous one, and notify
   * double-click subscribers.
   *
   * Must run from the tracker's handlers (through `_releasePress`), behind the
   * `_forwarding` guard: that is what keeps the synthetic copies
   * `_forwardToFabric` dispatches out of the stream. A held pointer's lift
   * never reaches it, so a finger resting beside two taps neither pairs with
   * them nor breaks their pair. The gates and their thresholds are documented
   * in the "Double clicks" section of the OSD-Fabric integration guide.
   */
  private _detectDoubleClick(originalEvent: PointerEvent): void {
    const press = this._pendingPress;
    // Another pointer's release is not this press's: leave the press pending
    // for its own release, and let nothing pair with it.
    if (press !== null && press.pointerId !== originalEvent.pointerId) {
      this._lastClick = null;
      return;
    }
    this._pendingPress = null;

    // The pan pass-through trigger, not a click. Tested directly because
    // `preProcessEventHandler` has already cleared `_panGestureActive` by now.
    if (originalEvent.ctrlKey || originalEvent.metaKey) {
      this._lastClick = null;
      return;
    }

    const { x, y } = this._toElementPoint(originalEvent);
    const time = originalEvent.timeStamp;

    // No matching press (pressed elsewhere, released over us), or too far from
    // its own press in time or space: a drag, not a click.
    const isClick =
      press !== null &&
      press.pointerId === originalEvent.pointerId &&
      time - press.time <= this._overlayTracker.clickTimeThreshold &&
      Math.hypot(x - press.x, y - press.y) <= this._overlayTracker.clickDistThreshold;
    if (!isClick) {
      this._lastClick = null;
      return;
    }

    const previous = this._lastClick;
    this._lastClick = { time, x, y, pointerType: originalEvent.pointerType, seq: press.seq };

    if (!previous) return;
    // A pair must be the same pointer type. Touch reaches here since #175;
    // before that the contact count never returned to zero, so the release
    // this runs from was never delivered for touch at all.
    if (previous.pointerType !== originalEvent.pointerType) return;
    if (time - previous.time > this._overlayTracker.dblClickTimeThreshold) return;
    if (Math.hypot(x - previous.x, y - previous.y) > this._overlayTracker.dblClickDistThreshold) {
      return;
    }

    // Consume the pair, so a triple click fires once.
    this._lastClick = null;

    if (this._doubleClickSubscribers.size === 0) return;
    const imagePoint = this.screenToImage({ x, y });
    // Snapshot + membership check: a callback can subscribe or unsubscribe
    // synchronously, and neither the additions nor the removals belong to this
    // gesture. See the integration guide.
    // The release is neither of the two presses, so a subscriber cannot recover
    // the pair from `originalEvent`; only the overlay knows it.
    const pressSeqs: readonly [number, number] = [previous.seq, press.seq];
    for (const callback of [...this._doubleClickSubscribers]) {
      if (!this._doubleClickSubscribers.has(callback)) continue;
      callback(originalEvent, imagePoint, pressSeqs);
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
   * Moves keyboard focus to the viewer, as the browser would have done itself.
   *
   * In annotation and custom-control mode the overlay prevents the default of
   * every press it owns. That also cancels the browser's own focus change, so
   * whatever had focus kept it: a toolbar button reached with Tab stayed
   * focused while the user drew with the mouse, and a later Enter went to the
   * button instead of finishing the polyline (#189). A press on the image
   * would natively focus the nearest focusable ancestor, which is OSD's canvas
   * (`tabIndex` 0); this restores exactly that. OSD's own key bindings on the
   * canvas are suppressed (`_onCanvasKey`), so focusing it cannot trigger
   * them, and it is where a navigation-mode click already puts focus.
   *
   * Called after the press has been forwarded, matching the browser's order.
   * A Ctrl/Cmd-drag pan is OSD's to handle and does not come through here,
   * and neither does a right or middle press, which the overlay does not
   * handle.
   */
  private _focusViewerOnPress(): void {
    const canvas = this._viewer.canvas;
    if (canvas.ownerDocument.activeElement !== canvas) {
      canvas.focus({ preventScroll: true });
    }
  }

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
          // A pointer pressing has lifted, whatever the overlay saw of it.
          this._heldPointers.delete(domEvent.pointerId);
          const press = this._pendingPress;
          if (press !== null && !this._panGestureActive) {
            if (
              press.pointerType === 'touch' &&
              (domEvent.pointerType === 'pen' || domEvent.pointerType === 'mouse')
            ) {
              // A touch never wins over a pen or a mouse. A touch press still
              // held when one of them presses is a hand at rest: the palm the
              // pencil landed after, which the platform had not yet
              // cancelled, or a finger left on a touchscreen while the other
              // hand took the mouse. So undo its press as a cancel would
              // (`_cancelPress`: revert, tell the tool, end Fabric's gesture
              // with a release that commits nothing), hold the rest of it,
              // and let this press through as the real one. Holding this
              // pointer instead swallowed the whole of its stroke, and the
              // finger's lift then committed what the finger had done.
              //
              // Any press of the pen or mouse counts, whatever its button or
              // modifiers: a right-button or a Ctrl/Cmd press shows as
              // plainly where the hand is. What the press then does is
              // decided below, as for any press: a pan trigger pans, and a
              // press of a button other than the primary one starts nothing
              // (OSD reports it only to a `nonPrimaryPressHandler`, which
              // this tracker does not register). The reverse, a touch beside
              // a pen or mouse press, is a second pointer, held below.
              this._heldPointers.add(press.pointerId);
              this._cancelPress(domEvent, true);
            } else if (
              this._mode === 'paint' &&
              domEvent.pointerType === press.pointerType &&
              domEvent.pointerId !== press.pointerId
            ) {
              // A second contact of the same kind while a stroke is being
              // painted: the start of a pinch, or a palm. End the stroke here,
              // as it stands, rather than let it paint on until the first
              // finger lifts; the newcomer is then held below. Paint mode
              // only: in annotation mode the first finger keeps its gesture
              // until its own lift.
              this._endPendingPress(domEvent);
            }
          }
          if (this._isSecondPointer(domEvent)) {
            // Held: it starts nothing, not even a pan, until it lifts and
            // presses again. Nor does OSD see it: `preventGesture` keeps its
            // press and release handlers quiet and its pinch unstarted (its
            // contact is still counted, and removed again on its release).
            this._hold(eventInfo, domEvent);
            return;
          }

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
          // A held pointer with a button down: swallowed whole. One with no
          // button down has lifted unseen; `_movesFabric` lets it go.
          if (this._heldPointers.has(domEvent.pointerId) && domEvent.buttons !== 0) {
            eventInfo.preventGesture = true;
            eventInfo.stopPropagation = true;
            eventInfo.preventDefault = true;
            return;
          }
          if (this._panGestureActive) {
            // Part of an OSD pan gesture — let it through
            return;
          }
          // A chord: the primary button released while another is still
          // held arrives as a move with the primary bit clear, and the later
          // `pointerup` names the other button, which OSD ignores. No release
          // would ever be reported for this press, so end it here. Mouse and
          // pen only: a touch contact's `buttons` is 1 for its whole life.
          if (
            this._pendingPress !== null &&
            domEvent.pointerId === this._pendingPress.pointerId &&
            domEvent.pointerType !== 'touch' &&
            (domEvent.buttons & 1) === 0
          ) {
            this._endPendingPress(domEvent);
          }
          eventInfo.stopPropagation = true;
          eventInfo.preventDefault = true;
          return;
        }

        if (eventType === POINTER_UP || eventType === POINTER_CANCEL) {
          if (this._heldPointers.delete(domEvent.pointerId)) {
            // A held pointer lifts: that ends nothing, here or, should OSD
            // report it as the last contact, in `releaseHandler`.
            this._handledReleases.add(domEvent);
            eventInfo.preventGesture = true;
            eventInfo.stopPropagation = true;
            eventInfo.preventDefault = true;
            return;
          }
          if (this._panGestureActive) {
            // End of OSD pan gesture
            this._panGestureActive = false;
            this._viewer.setMouseNavEnabled(false);
            return;
          }
          eventInfo.stopPropagation = true;
          eventInfo.preventDefault = true;
          if (eventType === POINTER_CANCEL) {
            // OSD never calls `releaseHandler` for a cancelled pointer, so
            // this is the only place the overlay hears of the cancel.
            this._cancelPress(domEvent);
          } else if (this._pendingPress?.pointerId === domEvent.pointerId) {
            // The pointer that pressed has lifted: end the gesture here, not
            // in `releaseHandler`, which OSD skips while another contact of
            // this type is down. See `_releasePress`.
            this._releasePress(domEvent);
          }
          return;
        }
      },

      pressHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;

        const originalEvent = event.originalEvent as PointerEvent;
        // Focus moves after the press is delivered, as the browser orders it:
        // the focus change is the press's default action, so handlers see the
        // press before any blur it causes.
        if (this._mode === 'customControl') {
          this._customControlHandler?.onPointerDown?.(this._buildCustomControlEvent(originalEvent));
          this._focusViewerOnPress();
          return;
        }

        if (this._panGestureActive) return;
        // `preProcessEventHandler` silences OSD's press handler for a held
        // pointer; this is the belt to that, should a tracker ever call it.
        if (this._heldPointers.has(originalEvent.pointerId)) return;
        this._forwardToFabric(POINTER_DOWN, originalEvent, this._recordPress(originalEvent));
        this._focusViewerOnPress();
      },

      moveHandler: (event: OpenSeadragon.MouseTrackerEvent) => {
        if (this._forwarding || this._mode === 'navigation') return;

        const originalEvent = event.originalEvent as PointerEvent;
        if (this._mode === 'customControl') {
          this._customControlHandler?.onPointerMove?.(this._buildCustomControlEvent(originalEvent));
          return;
        }

        if (this._panGestureActive) return;
        if (!this._movesFabric(originalEvent)) return;
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
        // Ended, or dropped, in `preProcessEventHandler` already.
        if (this._handledReleases.has(originalEvent)) return;
        // While a press is in progress, only its own pointer's lift ends it
        // (a mouse pressed outside the viewer and released over it, say).
        const press = this._pendingPress;
        if (press !== null && press.pointerId !== originalEvent.pointerId) return;
        this._releasePress(originalEvent);
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

/** Whether two point lists hold the same coordinates, in order. */
function samePoints(
  a: readonly { readonly x: number; readonly y: number }[],
  b: readonly { readonly x: number; readonly y: number }[],
): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);
}
