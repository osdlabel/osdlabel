import { Control, Point, Polygon, Polyline, controlsUtils, util } from 'fabric';
import type {
  Canvas,
  FabricObject,
  TMat2D,
  TPointerEvent,
  TPointerEventInfo,
  Transform,
} from 'fabric';
import type { ToolOverlay } from './types.js';

/** Minimum vertices required to keep a shape valid. */
const MIN_POLYGON_POINTS = 3;
const MIN_POLYLINE_POINTS = 2;

/** Default long-press duration (ms) before vertex-edit mode engages. */
export const DEFAULT_VERTEX_EDIT_LONG_PRESS_MS = 500;
/** Default pointer travel (screen px) that cancels the long-press. */
export const DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX = 8;

/** Caller-tunable long-press configuration (no `isDrawing` predicate). */
export interface VertexEditConfig {
  readonly longPressMs: number;
  readonly moveTolerancePx: number;
}

/** Tuning for the long-press gesture that enters vertex-edit mode. */
export interface PolyVertexEditorOptions {
  /** How long (ms) the pointer must be held still on a poly to enter edit mode. */
  readonly longPressMs: number;
  /** Pointer travel (screen px) that cancels the long-press (treated as a drag). */
  readonly moveTolerancePx: number;
  /**
   * Predicate the editor consults before arming the long-press. Drawing tools
   * pass a getter that is `true` while a draw is in progress, so holding over an
   * existing shape mid-draw never hijacks the gesture.
   */
  readonly isDrawing?: () => boolean;
}

/**
 * Interactive vertex editing for polygon / polyline annotations, built on
 * Fabric v7's native poly controls (`controlsUtils.createPolyControls`, which
 * already moves vertices and fires `object:modified`). On top of that this adds:
 *
 * - a configurable **long-press** to enter a sticky edit mode (tablet-friendly),
 * - **edge-insertion** handles at edge midpoints that splice a new vertex: a
 *   click commits it at the midpoint, a drag moves it and commits it on
 *   release, and
 * - **vertex deletion** (Delete/Backspace) honoring per-shape minimums, which
 *   leaves every other vertex where it is and waits for the pointer to be
 *   released.
 *
 * Every edit (vertex move, insertion, deletion) commits through the host's
 * existing `object:modified` → `getGeometryFromFabricObject` path. The editor
 * is Fabric-only (SolidJS / OSD agnostic) and is owned by the Select /
 * Polyline / Free-draw tools.
 */
export class PolyVertexEditor {
  private canvas: Canvas | null = null;

  /** The object currently in edit mode, and its annotation id (for re-attach). */
  private editingObject: Polyline | null = null;
  private editingId: string | null = null;
  /**
   * The vertex control last pressed (e.g. `'p2'`), used as the Delete/Backspace
   * target. Tracked here because Fabric clears `obj.__corner` on mouse up, so by
   * the time a key is pressed the hovered-corner state is already gone.
   */
  private activeVertexKey: string | null = null;
  /**
   * `activeVertexKey` as it was before the press in progress on the edited
   * shape changed it, or `undefined` while there is no such press. A
   * cancelled press puts it back (see {@link onPointerCancel}).
   */
  private keyBeforePress: string | null | undefined = undefined;

  /** Long-press bookkeeping. */
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTarget: Polyline | null = null;
  private pressViewportPoint: { x: number; y: number } | null = null;

  private readonly longPressMs: number;
  private readonly moveTolerancePx: number;
  private readonly isDrawing: (() => boolean) | undefined;

  private readonly onMouseDown = (e: TPointerEventInfo<TPointerEvent>) => this.handleMouseDown(e);
  private readonly onMouseMove = (e: TPointerEventInfo<TPointerEvent>) => this.handleMouseMove(e);
  private readonly onMouseUp = () => this.handleMouseUp();
  private readonly onObjectAdded = (e: { target: FabricObject }) =>
    this.handleObjectAdded(e.target);

  constructor(options: PolyVertexEditorOptions) {
    this.longPressMs = options.longPressMs;
    this.moveTolerancePx = options.moveTolerancePx;
    this.isDrawing = options.isDrawing;
  }

  activate(overlay: ToolOverlay): void {
    this.canvas = overlay.canvas;
    this.canvas.on('mouse:down', this.onMouseDown);
    this.canvas.on('mouse:move', this.onMouseMove);
    this.canvas.on('mouse:up', this.onMouseUp);
    this.canvas.on('object:added', this.onObjectAdded);
  }

  deactivate(): void {
    this.clearPress();
    this.exitEditMode();
    if (this.canvas) {
      this.canvas.off('mouse:down', this.onMouseDown);
      this.canvas.off('mouse:move', this.onMouseMove);
      this.canvas.off('mouse:up', this.onMouseUp);
      this.canvas.off('object:added', this.onObjectAdded);
    }
    this.canvas = null;
  }

  /** Whether a poly is currently in vertex-edit mode. */
  isEditing(): boolean {
    return this.editingObject !== null;
  }

  /**
   * Handle a key while editing. Returns true when consumed.
   * Escape exits edit mode; Delete/Backspace removes the hovered/active vertex.
   *
   * Delete/Backspace are ignored while the pointer is held (Fabric has a
   * transform in progress, such as a vertex drag) and work again once it is
   * released. Fabric's transform stays bound to the vertex index and the
   * placement its press found, so a vertex removed under it would leave the
   * drag moving whichever vertex took that index, and the release committing
   * it there. Ignored or not, they are consumed. Escape stays live mid-drag:
   * it changes only the handles, and the drag goes on moving the vertex it
   * began on, which the release commits as painted.
   */
  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.editingObject) return false;
    if (event.key === 'Escape') {
      this.exitEditMode();
      return true;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Consumed even when ignored, so a vertex delete never falls through to
      // deleting the whole annotation (the host tool's default Delete action).
      if (!this.canvas?._currentTransform) this.deleteActiveVertex();
      return true;
    }
    return false;
  }

  /**
   * The press in progress was cancelled (`pointercancel`, or a touch press a
   * pen or a mouse took over; see `AnnotationTool.onPointerCancel`). Called by
   * the tool that owns the editor, after `FabricOverlay` has put the shape
   * back, points included.
   *
   * A long press it interrupted must not enter edit mode when its timer
   * fires. In edit mode the Delete target goes back to the one before the
   * press: a press on the shape chooses the target, and an insert handle's
   * press chooses the vertex it inserted, which the overlay has just taken
   * back. Left in place, that key names the vertex that slid back into its
   * index, which the next Delete would remove. The earlier key indexes the
   * points the overlay restored, so it still names the vertex it did. And the
   * handles are rebuilt for the points the shape now has: the insert handle
   * rebuilds them for its new vertex, and once that vertex is gone the extra
   * handles would point past the end of `points`.
   */
  onPointerCancel(): void {
    this.clearPress();
    const keyBeforePress = this.keyBeforePress;
    this.keyBeforePress = undefined;
    const poly = this.editingObject;
    if (!poly) return;
    if (keyBeforePress !== undefined) this.activeVertexKey = keyBeforePress;
    poly.controls = buildEditControls(poly);
    poly.setCoords();
    poly.set('dirty', true);
    this.canvas?.requestRenderAll();
  }

  // ── Long-press detection ───────────────────────────────────────────────────

  private handleMouseDown(e: TPointerEventInfo<TPointerEvent>): void {
    this.clearPress();
    this.keyBeforePress = undefined;
    const target = e.target;

    if (this.editingObject) {
      if (target === this.editingObject) {
        // Pressing a vertex control records it as the deletion target, and
        // pressing an insert handle records the vertex it inserted (its
        // mouseDownHandler has already pointed `__corner` at it); pressing the
        // body clears it. Fabric has already set `__corner` for this mouse:down
        // (cleared again on the matching mouse:up). The previous target is
        // kept until the release, for a cancel to put back.
        this.keyBeforePress = this.activeVertexKey;
        const corner = this.editingObject.__corner;
        this.activeVertexKey = corner && corner.startsWith('p') ? corner : null;
        return; // let Fabric's control pipeline handle the interaction
      }
      // Clicked away from the edited shape — leave edit mode.
      this.exitEditMode();
    }

    const poly = this.editablePoly(target);
    if (!poly) return;
    if (this.isDrawing?.()) return;

    this.pressTarget = poly;
    this.pressViewportPoint = { x: e.viewportPoint.x, y: e.viewportPoint.y };
    this.pressTimer = setTimeout(() => {
      if (this.pressTarget) this.enterEditMode(this.pressTarget);
      this.clearPress();
    }, this.longPressMs);
  }

  private handleMouseMove(e: TPointerEventInfo<TPointerEvent>): void {
    if (!this.pressTimer || !this.pressViewportPoint) return;
    const dx = e.viewportPoint.x - this.pressViewportPoint.x;
    const dy = e.viewportPoint.y - this.pressViewportPoint.y;
    if (Math.sqrt(dx * dx + dy * dy) > this.moveTolerancePx) {
      this.clearPress();
    }
  }

  private handleMouseUp(): void {
    this.clearPress();
    this.keyBeforePress = undefined;
  }

  private clearPress(): void {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
    this.pressTarget = null;
    this.pressViewportPoint = null;
  }

  // ── Edit-mode lifecycle ────────────────────────────────────────────────────

  private enterEditMode(poly: Polyline): void {
    if (!this.canvas || poly === this.editingObject) return;
    this.editingObject = poly;
    this.editingId = poly.id ?? null;
    this.activeVertexKey = null;
    this.applyEditControls(poly);
  }

  private exitEditMode(): void {
    const poly = this.editingObject;
    this.editingObject = null;
    this.editingId = null;
    this.activeVertexKey = null;
    this.keyBeforePress = undefined;
    if (!poly) return;
    poly.controls = controlsUtils.createObjectDefaultControls();
    // Refresh oCoords so hit-testing matches the restored default control keys.
    poly.setCoords();
    poly.set('dirty', true);
    this.canvas?.requestRenderAll();
  }

  /**
   * After a vertex edit commits, the host rebuilds the Fabric object from state
   * (a fresh instance with default controls). Re-apply edit controls to the new
   * instance so the edit session continues without another long-press.
   */
  private handleObjectAdded(target: FabricObject): void {
    if (!this.editingId || !this.canvas) return;
    if (target === this.editingObject) return;
    if (target.id !== this.editingId || !(target instanceof Polyline)) return;
    this.editingObject = target;
    this.applyEditControls(target);
  }

  /**
   * Switches a poly into edit mode: detaches its points from the (immutable)
   * source store, installs the vertex + insert controls, and refreshes the
   * control hit-test coords.
   */
  private applyEditControls(poly: Polyline): void {
    if (!this.canvas) return;
    // The Fabric object's `points` array is deserialized straight from the
    // framework store (Solid/Immer), so it is immutable. Fabric's vertex / insert
    // / delete handlers mutate `points` in place, which would throw "Cannot mutate
    // a Store directly". Copy to a plain, detached array first.
    poly.points = poly.points.map((p) => new Point(p.x, p.y));
    poly.setDimensions();
    poly.controls = buildEditControls(poly);
    // oCoords is computed from the control set; without this, control hit-testing
    // (findControl) still iterates the previous default keys and crashes.
    poly.setCoords();
    poly.set('dirty', true);
    this.canvas.setActiveObject(poly);
    this.canvas.requestRenderAll();
  }

  private deleteActiveVertex(): boolean {
    const poly = this.editingObject;
    if (!poly || !this.canvas) return false;
    // Prefer the last vertex the user pressed; fall back to a currently-hovered
    // corner so hover-then-delete still works.
    const corner = this.activeVertexKey ?? poly.__corner;
    if (!corner || !corner.startsWith('p')) return false;
    const index = Number.parseInt(corner.slice(1), 10);
    if (!Number.isInteger(index) || index < 0 || index >= poly.points.length) return false;

    const min = poly instanceof Polygon ? MIN_POLYGON_POINTS : MIN_POLYLINE_POINTS;
    if (poly.points.length <= min) return false;

    removeVertexInPlace(poly, index);
    poly.controls = buildEditControls(poly);
    poly.setCoords();
    this.activeVertexKey = null;
    delete poly.__corner;
    poly.set('dirty', true);
    // Commit through the host's object:modified → state path.
    this.canvas.fire('object:modified', { target: poly });
    this.canvas.requestRenderAll();
    return true;
  }

  private editablePoly(target: FabricObject | undefined): Polyline | null {
    if (!target || !target.id || target._readOnly) return null;
    return target instanceof Polyline ? target : null;
  }
}

/**
 * Removes vertex `index` from `poly` and leaves every other vertex where it
 * was, in `poly`'s parent plane (image space on an annotation canvas).
 *
 * Fabric draws the points about `pathOffset`, the centre of their bounding
 * box, which `setDimensions()` recomputes, while `left` / `top` stay put. So
 * removing a vertex that alone holds a side of the box moves the box's centre
 * and, through the object's transform, every remaining vertex with it.
 * Fabric's own vertex move (`factoryPolyActionHandler`) compensates by
 * keeping one vertex fixed, and so does this: a vertex that stays is the
 * anchor, measured through `calcOwnMatrix()` before and after, and `left` /
 * `top` take the difference back. Only the translation changes (angle,
 * scale, skew and flip do not), so fixing one vertex fixes them all, under
 * any origin.
 */
function removeVertexInPlace(poly: Polyline, index: number): void {
  const anchor = new Point(poly.points[index === 0 ? 1 : 0]!);
  const before = anchor.subtract(poly.pathOffset).transform(poly.calcOwnMatrix());
  poly.points.splice(index, 1);
  poly.setDimensions();
  const after = anchor.subtract(poly.pathOffset).transform(poly.calcOwnMatrix());
  poly.set({ left: poly.left - (after.x - before.x), top: poly.top - (after.y - before.y) });
}

// ── Control construction ───────────────────────────────────────────────────

/**
 * Builds the control set for edit mode: Fabric's native per-vertex move
 * controls (`p0`, `p1`, …) plus edge-midpoint insertion controls (`ins0`, …).
 * Index-keyed, so it must be rebuilt after any splice.
 */
function buildEditControls(poly: Polyline): Record<string, Control> {
  const vertexControls = controlsUtils.createPolyControls(poly);
  const isClosed = poly instanceof Polygon;
  const edgeCount = isClosed ? poly.points.length : poly.points.length - 1;

  const insertControls: Record<string, Control> = {};
  for (let edge = 0; edge < edgeCount; edge++) {
    insertControls[`ins${edge}`] = new Control({
      actionName: 'insertPoint',
      cursorStyle: 'cell',
      positionHandler: makeInsertPositionHandler(edge),
      mouseDownHandler: makeInsertMouseDownHandler(edge),
      // Movement after insertion is driven by the redirected vertex handler.
      actionHandler: () => false,
      render: controlsUtils.renderCircleControl,
    });
  }

  return { ...vertexControls, ...insertControls };
}

/** Locates an edge-insert handle at the midpoint of edge (i, i+1), in canvas space. */
function makeInsertPositionHandler(edge: number) {
  return function positionHandler(
    _dim: Point,
    _finalMatrix: TMat2D,
    fabricObject: FabricObject,
  ): Point {
    const poly = fabricObject as Polyline;
    const n = poly.points.length;
    const a = poly.points[edge]!;
    const b = poly.points[(edge + 1) % n]!;
    const mid = new Point((a.x + b.x) / 2, (a.y + b.y) / 2).subtract(poly.pathOffset);
    return mid.transform(
      util.multiplyTransformMatrices(poly.getViewportTransform(), poly.calcTransformMatrix()),
    );
  };
}

/**
 * On press of an edge-insert handle: splice a new vertex at the edge midpoint,
 * rebuild controls, then redirect the in-flight transform to the new vertex's
 * move handler, so a drag moves the new vertex with the pointer.
 *
 * The insertion is an edit even if the pointer never moves, so the press marks
 * the transform as performed. Fabric fires `object:modified` on release only
 * for a performed transform, and sets the flag itself only when a pointer move
 * runs the action handler; without this, a click (press and release without
 * moving) left a vertex on the canvas that state never received, and the next
 * rebuild dropped it. The vertex stays at the midpoint until the pointer
 * moves, wherever on the handle the press landed: a click commits it there,
 * a drag where it is released.
 */
function makeInsertMouseDownHandler(edge: number) {
  // The press position is deliberately unused: see above.
  return function mouseDownHandler(_eventData: TPointerEvent, transform: Transform): boolean {
    const poly = transform.target as Polyline;
    const n = poly.points.length;
    const a = poly.points[edge]!;
    const b = poly.points[(edge + 1) % n]!;
    const insertIndex = edge + 1;

    poly.points.splice(insertIndex, 0, new Point((a.x + b.x) / 2, (a.y + b.y) / 2));
    poly.setDimensions();
    poly.controls = buildEditControls(poly);
    poly.setCoords();
    // Commit on release even if the pointer never moves.
    transform.actionPerformed = true;

    const key = `p${insertIndex}`;
    const vertexControl = poly.controls[key];
    if (!vertexControl) return true;

    // Redirect the active transform to the new vertex's move handler. Fabric
    // reads transform.actionHandler on every subsequent pointer move.
    transform.corner = key;
    transform.action = vertexControl.actionName;
    transform.actionHandler = vertexControl.actionHandler;
    poly.__corner = key;

    poly.set('dirty', true);
    poly.canvas?.requestRenderAll();
    return true;
  };
}
