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

export class PolylineTool extends BaseTool {
  readonly type: ToolType = 'polyline';
  private preview: Polyline | null = null;
  /** Committed vertices (does not include the live cursor point) */
  private vertices: Point[] = [];
  /**
   * The press that placed each vertex, parallel to {@link vertices} (#176).
   *
   * Parallel rather than an array of `{ point, seq }` so that
   * `markers.sync(overlay, this.vertices, …)` keeps receiving the existing
   * array — that redraw runs on every pointer move and is documented as
   * allocation-free, which mapping a record array per frame would break.
   * The pairing invariant is held by `pushVertex` / `popVertex` being the only
   * mutators; index `i` of one always describes index `i` of the other.
   */
  private vertexSeqs: (number | undefined)[] = [];
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

  onPointerDown(event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay) return;
    // Stamped on whichever vertex this press places, so `onDoubleClick` can
    // drop exactly the vertices the gesture created.
    const seq = this.overlay.pressSeqOf(event);

    if (this.vertices.length === 0) {
      // First point — start a new path
      this.pushVertex(imagePoint, seq);

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
      this.pushVertex(imagePoint, seq);

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
  onDoubleClick(
    _event: PointerEvent,
    _imagePoint: Point,
    pressSeqs?: readonly [number, number],
  ): void {
    this.dropGestureVertices(pressSeqs);
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
   * Remove the redundant vertex a double click's second press added.
   *
   * A double click delivers both of its presses before this callback, and the
   * user's intent is that the path ends *at* the double-clicked point — so the
   * first press places a real vertex and only the second is an artefact.
   *
   * It is dropped only when the first press placed the vertex before it. If
   * just one press reached the tool — the other was suppressed by the
   * framework hooks for landing on an existing annotation, or closed the path
   * — then the single vertex is the endpoint the user asked for, and removing
   * it would discard a deliberate click (and on a short path, take the whole
   * path below `finish`'s minimum).
   *
   * Matching on the press sequence makes each of those the same rule, with no
   * screen-distance bounds and no window in which a user's own vertex can be
   * mistaken for the gesture's. `pressSeqs` is absent, and a stamp is
   * `undefined`, exactly when the press was not one the overlay forwarded —
   * including every event a unit test builds by hand — and nothing is dropped
   * then, which is the safe direction: a stray vertex is recoverable, a
   * silently deleted one is not.
   */
  private dropGestureVertices(pressSeqs?: readonly [number, number]): void {
    if (!pressSeqs) return;
    const count = this.vertexSeqs.length;
    if (count < 2) return;
    const [firstSeq, secondSeq] = pressSeqs;
    if (this.vertexSeqs[count - 1] !== secondSeq) return;
    if (this.vertexSeqs[count - 2] !== firstSeq) return;
    this.popVertex();
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
    this.vertexSeqs = [];
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
    this.vertexSeqs = [];
    this.style = null;
  }

  /** The only way to add a vertex, so the sequence array cannot drift. */
  private pushVertex(point: Point, seq: number | undefined): void {
    this.vertices.push({ x: point.x, y: point.y });
    this.vertexSeqs.push(seq);
  }

  /** The only way to remove a vertex, so the sequence array cannot drift. */
  private popVertex(): void {
    this.vertices.pop();
    this.vertexSeqs.pop();
  }
}
