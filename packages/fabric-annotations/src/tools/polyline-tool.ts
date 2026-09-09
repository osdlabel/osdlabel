import { Polyline, Polygon } from 'fabric';
import { BaseTool } from './base-tool.js';
import {
  type ToolType,
  type Point,
  type AnnotationStyle,
  createAnnotationId,
  generateId,
} from '@osdlabel/annotation';
import type { ImageId, KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { getFabricOptions } from '../fabric-utils.js';
import { getPreviewOptions } from '../preview-style.js';
import { VertexMarkerLayer, type VertexMarkerOptions } from '../vertex-markers.js';
import type { ToolOverlay } from '../types.js';
import type { ToolCallbacks } from './base-tool.js';
import {
  PolyVertexEditor,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  type VertexEditConfig,
} from '../poly-vertex-editor.js';

/** Distance in screen pixels to snap-close to the first point */
const CLOSE_THRESHOLD_SCREEN_PX = 10;

/**
 * Screen-pixel bounds on where a double click's two presses can be, relative to
 * the release point reported to {@link PolylineTool.onDoubleClick}. Composed
 * from OpenSeadragon's defaults — 5 for the second press, 5 + 20 + 5 for the
 * first — and derived in the OSD-Fabric integration guide.
 */
const SECOND_PRESS_SCREEN_PX = 5;
const FIRST_PRESS_SCREEN_PX = 25;

export class PolylineTool extends BaseTool {
  readonly type: ToolType = 'polyline';
  private preview: Polyline | null = null;
  /** Committed vertices (does not include the live cursor point) */
  private vertices: Point[] = [];
  /** Style resolved when drawing started; drives the preview only. */
  private style: AnnotationStyle | null = null;
  private readonly editor: PolyVertexEditor;
  private readonly markers: VertexMarkerLayer;

  constructor(
    config: VertexEditConfig = {
      longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    },
    markerOptions: VertexMarkerOptions = {},
  ) {
    super();
    this.editor = new PolyVertexEditor({ ...config, isDrawing: () => this.vertices.length > 0 });
    this.markers = new VertexMarkerLayer(markerOptions);
  }

  activate(
    overlay: ToolOverlay,
    imageId: ImageId,
    callbacks: ToolCallbacks,
    shortcuts: KeyboardShortcutMap,
  ): void {
    super.activate(overlay, imageId, callbacks, shortcuts);
    if (this.overlay) this.editor.activate(this.overlay);
  }

  deactivate(): void {
    this.editor.deactivate();
    super.deactivate();
  }

  onPointerDown(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay) return;

    if (this.vertices.length === 0) {
      // First point — start a new path
      this.vertices.push({ x: imagePoint.x, y: imagePoint.y });

      // Draw the preview in the style the finished annotation will have, so the
      // shape stays visible while it is being drawn (see issue #156).
      this.style = this.resolveStyle();
      this.preview = new Polyline(
        [
          { x: imagePoint.x, y: imagePoint.y },
          { x: imagePoint.x, y: imagePoint.y },
        ],
        getPreviewOptions(this.style, this.overlay.canvas.getZoom()),
      );
      this.preview._readOnly = true;
      this.overlay.canvas.add(this.preview);
    } else {
      // Check if clicking near the first point to close
      if (this.canClose(imagePoint)) {
        this.finish(true);
        return;
      }

      // Add new vertex
      this.vertices.push({ x: imagePoint.x, y: imagePoint.y });

      // Update preview: all committed vertices + a live cursor point
      if (this.preview) {
        const previewPoints = [
          ...this.vertices.map((p) => ({ x: p.x, y: p.y })),
          { x: imagePoint.x, y: imagePoint.y },
        ];
        this.preview.set({ points: previewPoints });
      }
    }

    this.syncMarkers(imagePoint);
    this.overlay.canvas.requestRenderAll();
  }

  onPointerMove(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.preview || this.vertices.length === 0) return;

    // Update the last (live cursor) point in the preview
    const previewPoints = [
      ...this.vertices.map((p) => ({ x: p.x, y: p.y })),
      { x: imagePoint.x, y: imagePoint.y },
    ];
    this.preview.set({ points: previewPoints, dirty: true });
    this.syncMarkers(imagePoint);
    this.overlay.canvas.requestRenderAll();
  }

  onPointerUp(_event: PointerEvent, _imagePoint: Point): void {
    // No-op — path tool uses click (not drag) to add points
  }

  /**
   * Finish the in-progress path as an *open* polyline, dropping the vertex the
   * gesture's own second press added.
   *
   * The test is geometric, not a count: the gesture contributes two vertices,
   * one, or none — a press landing on an existing annotation is suppressed by
   * the hooks, and one may have closed the path — so popping unconditionally
   * discards a point the user placed, and on a two-vertex path throws the whole
   * path away.
   */
  onDoubleClick(_event: PointerEvent, imagePoint: Point): void {
    if (this.gestureAddedBothVertices(imagePoint)) this.vertices.pop();
    this.finish(false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (this.editor.onKeyDown(event)) return true;
    const shortcuts = this.shortcuts;
    const isDrawing = this.vertices.length > 0;

    if (isDrawing && shortcuts) {
      if (event.key === shortcuts.polylineFinish) {
        this.finish(false);
        return true;
      }
      if (event.key.toLowerCase() === shortcuts.polylineClose.toLowerCase()) {
        if (this.vertices.length >= 3) this.finish(true);
        return true; // always consume 'c' during drawing (prevent CircleTool switch)
      }
      if (event.key === shortcuts.polylineCancel) {
        this.cancel();
        return true; // prevent global Escape from also deactivating the tool
      }
    }
    return super.onKeyDown(event);
  }

  /**
   * Redraws the per-vertex markers. The first marker is highlighted whenever a
   * click at `imagePoint` would close the shape, since that 10px target is
   * otherwise invisible.
   */
  private syncMarkers(imagePoint: Point): void {
    if (!this.overlay || !this.style) return;
    this.markers.sync(this.overlay, this.vertices, this.style, this.canClose(imagePoint));
  }

  /** Whether a click at `imagePoint` would close the path into a polygon. */
  private canClose(imagePoint: Point): boolean {
    return this.vertices.length >= 3 && this.isNearFirstPoint(imagePoint);
  }

  /**
   * Whether *both* of this double click's presses landed on the canvas and so
   * added a vertex — the only case in which one of them is an artefact.
   *
   * Both halves are load-bearing; each alone gets a real case wrong, and the
   * integration guide sets out which. Screen space, like `isNearFirstPoint`,
   * because the bounds are properties of the input device.
   *
   * Not exact: with the first press suppressed *and* the previous vertex within
   * the first-press bound of the release, this drops the vertex the second
   * press placed. A far narrower window than the count-based test it replaced.
   */
  private gestureAddedBothVertices(imagePoint: Point): boolean {
    // Guard, not a decision: `finish` cancels a too-short path either way.
    if (this.vertices.length < 2 || !this.overlay) return false;
    const released = this.overlay.imageToScreen(imagePoint);
    const last = this.overlay.imageToScreen(this.vertices[this.vertices.length - 1]!);
    const previous = this.overlay.imageToScreen(this.vertices[this.vertices.length - 2]!);
    return (
      Math.hypot(last.x - released.x, last.y - released.y) <= SECOND_PRESS_SCREEN_PX &&
      Math.hypot(previous.x - released.x, previous.y - released.y) <= FIRST_PRESS_SCREEN_PX
    );
  }

  private isNearFirstPoint(imagePoint: Point): boolean {
    if (this.vertices.length === 0 || !this.overlay) return false;
    const first = this.vertices[0]!;

    const firstScreen = this.overlay.imageToScreen(first);
    const currentScreen = this.overlay.imageToScreen(imagePoint);

    const dx = currentScreen.x - firstScreen.x;
    const dy = currentScreen.y - firstScreen.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    return dist < CLOSE_THRESHOLD_SCREEN_PX;
  }

  private finish(closed: boolean) {
    if (!this.overlay || !this.imageId || !this.callbacks) {
      this.cancel();
      return;
    }

    // Need at least 2 points for an open path, 3 for a closed polygon
    const minPoints = closed ? 3 : 2;
    if (this.vertices.length < minPoints) {
      this.cancel();
      return;
    }

    const activeContextId = this.callbacks.getActiveContextId();
    if (!activeContextId) {
      console.warn('No active context, cannot create annotation');
      this.cancel();
      return;
    }

    if (!this.callbacks.canAddAnnotation(this.type)) {
      this.cancel();
      return;
    }

    // Re-resolved rather than reusing the style cached for the preview: the
    // active context can change mid-draw, and `finish()` reads the context id
    // live, so the committed annotation must be styled by the same context that
    // ends up owning it.
    const style = this.resolveStyle();
    const id = createAnnotationId(generateId());
    const options = getFabricOptions(style, id);
    const pts = this.vertices.map((p) => ({ x: p.x, y: p.y }));

    // Remove preview polyline and its vertex markers
    if (this.preview) {
      this.overlay.canvas.remove(this.preview);
    }
    this.markers.clear();

    // Create the final object (Polygon for closed, Polyline for open)
    let finalObj: Polyline;
    if (closed) {
      finalObj = new Polygon(pts, {
        ...options,
        selectable: true,
        evented: true,
      });
    } else {
      finalObj = new Polyline(pts, {
        ...options,
        fill: 'transparent',
        selectable: true,
        evented: true,
      });
    }

    this.overlay.canvas.add(finalObj);
    this.overlay.canvas.requestRenderAll();

    this.callbacks.addAnnotation({
      fabricObject: finalObj,
      imageId: this.imageId,
      contextId: activeContextId,
      type: this.type,
    });

    this.preview = null;
    this.vertices = [];
    this.style = null;
  }

  cancel(): void {
    this.markers.clear();
    if (this.overlay && this.preview) {
      this.overlay.canvas.remove(this.preview);
      this.overlay.canvas.requestRenderAll();
    }
    this.preview = null;
    this.vertices = [];
    this.style = null;
  }
}
