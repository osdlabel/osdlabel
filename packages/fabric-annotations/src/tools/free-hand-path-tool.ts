import { Polyline, Polygon } from 'fabric';
import { BaseTool } from './base-tool.js';
import {
  type ToolType,
  type Point,
  type AnnotationStyle,
  createAnnotationId,
  DEFAULT_ANNOTATION_STYLE,
  generateId,
} from '@osdlabel/annotation';
import type { ImageId, KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { getFabricOptions } from '../fabric-utils.js';
import type { ToolOverlay } from '../types.js';
import type { ToolCallbacks } from './base-tool.js';
import {
  PolyVertexEditor,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  type VertexEditConfig,
} from '../poly-vertex-editor.js';

/** Default minimum distance in screen pixels between consecutive sampled points */
const DEFAULT_MIN_SAMPLE_DISTANCE_SCREEN_PX = 3;

export class FreeHandPathTool extends BaseTool {
  readonly type: ToolType = 'freeHandPath';
  private preview: Polyline | null = null;
  private vertices: Point[] = [];
  private isDrawing = false;
  private shiftHeld = false;
  private readonly minSampleDistancePx: number;
  private readonly editor: PolyVertexEditor;

  constructor(
    options?: { minSampleDistancePx?: number },
    config: VertexEditConfig = {
      longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    },
  ) {
    super();
    this.minSampleDistancePx =
      options?.minSampleDistancePx ?? DEFAULT_MIN_SAMPLE_DISTANCE_SCREEN_PX;
    this.editor = new PolyVertexEditor({ ...config, isDrawing: () => this.isDrawing });
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

    this.isDrawing = true;
    this.shiftHeld = event.shiftKey;
    this.vertices = [{ x: imagePoint.x, y: imagePoint.y }];

    this.preview = new Polyline([{ x: imagePoint.x, y: imagePoint.y }], {
      fill: 'transparent',
      stroke: 'rgba(0,0,0,0.5)',
      strokeWidth: 2 / this.overlay.canvas.getZoom(),
      strokeDashArray: [5 / this.overlay.canvas.getZoom(), 5 / this.overlay.canvas.getZoom()],
      selectable: false,
      evented: false,
      strokeUniform: true,
      objectCaching: false,
    });
    this.overlay.canvas.add(this.preview);
    this.overlay.canvas.requestRenderAll();
  }

  onPointerMove(event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.isDrawing || !this.preview) return;

    // Track shift state continuously
    this.shiftHeld = event.shiftKey;

    // Minimum distance check in screen pixels
    const lastVertex = this.vertices[this.vertices.length - 1]!;
    const lastScreen = this.overlay.imageToScreen(lastVertex);
    const currentScreen = this.overlay.imageToScreen(imagePoint);
    const dx = currentScreen.x - lastScreen.x;
    const dy = currentScreen.y - lastScreen.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= this.minSampleDistancePx) {
      this.vertices.push({ x: imagePoint.x, y: imagePoint.y });
    }

    this.preview.set({
      points: [
        ...this.vertices.map((p) => ({ x: p.x, y: p.y })),
        { x: imagePoint.x, y: imagePoint.y },
      ],
      dirty: true,
    });
    this.overlay.canvas.requestRenderAll();
  }

  onPointerUp(_event: PointerEvent, _imagePoint: Point): void {
    if (!this.isDrawing) return;

    // Default is closed; shift held means open
    const closed = !this.shiftHeld;
    const minPoints = closed ? 3 : 2;

    if (this.vertices.length < minPoints) {
      this.cancel();
      return;
    }

    this.finish(closed);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (this.editor.onKeyDown(event)) return true;
    if (this.isDrawing && event.key === this.shortcuts?.cancel) {
      this.cancel();
      return true;
    }
    return super.onKeyDown(event);
  }

  private finish(closed: boolean) {
    if (!this.overlay || !this.imageId || !this.callbacks) {
      this.cancel();
      return;
    }

    const activeContextId = this.callbacks.getActiveContextId();
    if (!activeContextId) {
      this.cancel();
      return;
    }

    if (!this.callbacks.canAddAnnotation(this.type)) {
      this.cancel();
      return;
    }

    const toolConstraint = this.callbacks.getToolConstraint(this.type);
    const style: AnnotationStyle = {
      ...DEFAULT_ANNOTATION_STYLE,
      ...toolConstraint?.defaultStyle,
    };

    const id = createAnnotationId(generateId());
    const options = getFabricOptions(style, id);
    const pts = this.vertices.map((p) => ({ x: p.x, y: p.y }));

    // Remove preview
    if (this.preview) {
      this.overlay.canvas.remove(this.preview);
    }

    // Create final object
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
    this.isDrawing = false;
  }

  cancel(): void {
    if (this.overlay && this.preview) {
      this.overlay.canvas.remove(this.preview);
      this.overlay.canvas.requestRenderAll();
    }
    this.preview = null;
    this.vertices = [];
    this.isDrawing = false;
  }
}
