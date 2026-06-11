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
 * - **edge-insertion** handles at edge midpoints that splice a new vertex and
 *   continue the same drag, and
 * - **vertex deletion** (Delete/Backspace) honoring per-shape minimums.
 *
 * Vertex moves commit through the host's existing `object:modified` →
 * `getGeometryFromFabricObject` path. The editor is Fabric-only (SolidJS / OSD
 * agnostic) and is owned by the Select / Polyline / Free-draw tools.
 */
export class PolyVertexEditor {
  private canvas: Canvas | null = null;

  /** The object currently in edit mode, and its annotation id (for re-attach). */
  private editingObject: Polyline | null = null;
  private editingId: string | null = null;

  /** Long-press bookkeeping. */
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTarget: Polyline | null = null;
  private pressViewportPoint: { x: number; y: number } | null = null;

  private readonly longPressMs: number;
  private readonly moveTolerancePx: number;
  private readonly isDrawing: (() => boolean) | undefined;

  private readonly onMouseDown = (e: TPointerEventInfo<TPointerEvent>) => this.handleMouseDown(e);
  private readonly onMouseMove = (e: TPointerEventInfo<TPointerEvent>) => this.handleMouseMove(e);
  private readonly onMouseUp = () => this.clearPress();
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
   */
  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.editingObject) return false;
    if (event.key === 'Escape') {
      this.exitEditMode();
      return true;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Consume while editing so a vertex delete never falls through to
      // deleting the whole annotation (the host tool's default Delete action).
      this.deleteActiveVertex();
      return true;
    }
    return false;
  }

  // ── Long-press detection ───────────────────────────────────────────────────

  private handleMouseDown(e: TPointerEventInfo<TPointerEvent>): void {
    this.clearPress();
    const target = e.target;

    // A click on the object already being edited is left to Fabric's control
    // pipeline (vertex / insert handles). A click elsewhere exits edit mode.
    if (this.editingObject && target !== this.editingObject) {
      this.exitEditMode();
    }

    const poly = this.editablePoly(target);
    if (!poly || poly === this.editingObject) return;
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
    poly.controls = buildEditControls(poly);
    poly.set('dirty', true);
    this.canvas.setActiveObject(poly);
    this.canvas.requestRenderAll();
  }

  private exitEditMode(): void {
    const poly = this.editingObject;
    this.editingObject = null;
    this.editingId = null;
    if (!poly) return;
    poly.controls = controlsUtils.createObjectDefaultControls();
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
    target.controls = buildEditControls(target);
    target.set('dirty', true);
    this.canvas.setActiveObject(target);
    this.canvas.requestRenderAll();
  }

  private deleteActiveVertex(): boolean {
    const poly = this.editingObject;
    if (!poly || !this.canvas) return false;
    const corner = poly.__corner;
    if (!corner || !corner.startsWith('p')) return false;
    const index = Number.parseInt(corner.slice(1), 10);
    if (!Number.isInteger(index) || index < 0 || index >= poly.points.length) return false;

    const min = poly instanceof Polygon ? MIN_POLYGON_POINTS : MIN_POLYLINE_POINTS;
    if (poly.points.length <= min) return false;

    poly.points.splice(index, 1);
    poly.setDimensions();
    poly.controls = buildEditControls(poly);
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
 * move handler so the same drag rubber-bands the freshly inserted point.
 */
function makeInsertMouseDownHandler(edge: number) {
  return function mouseDownHandler(
    eventData: TPointerEvent,
    transform: Transform,
    x: number,
    y: number,
  ): boolean {
    const poly = transform.target as Polyline;
    const n = poly.points.length;
    const a = poly.points[edge]!;
    const b = poly.points[(edge + 1) % n]!;
    const insertIndex = edge + 1;

    poly.points.splice(insertIndex, 0, new Point((a.x + b.x) / 2, (a.y + b.y) / 2));
    poly.setDimensions();
    poly.controls = buildEditControls(poly);

    const key = `p${insertIndex}`;
    const vertexControl = poly.controls[key];
    if (!vertexControl) return true;

    // Redirect the active transform to the new vertex's move handler. Fabric
    // reads transform.actionHandler on every subsequent pointer move.
    transform.corner = key;
    transform.action = vertexControl.actionName;
    transform.actionHandler = vertexControl.actionHandler;
    poly.__corner = key;

    vertexControl.actionHandler(eventData, transform, x, y);
    poly.set('dirty', true);
    poly.canvas?.requestRenderAll();
    return true;
  };
}
