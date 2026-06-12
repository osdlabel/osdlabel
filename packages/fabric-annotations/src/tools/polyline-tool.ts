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

/** Distance in screen pixels to snap-close to the first point */
const CLOSE_THRESHOLD_SCREEN_PX = 10;

export class PolylineTool extends BaseTool {
  readonly type: ToolType = 'polyline';
  private preview: Polyline | null = null;
  /** Committed vertices (does not include the live cursor point) */
  private vertices: Point[] = [];
  private readonly editor: PolyVertexEditor;

  constructor(
    config: VertexEditConfig = {
      longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    },
  ) {
    super();
    this.editor = new PolyVertexEditor({ ...config, isDrawing: () => this.vertices.length > 0 });
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

    // Handle double click to finish as open polyline
    if (event.detail === 2) {
      this.finish(false);
      return;
    }

    if (this.vertices.length === 0) {
      // First point — start a new path
      this.vertices.push({ x: imagePoint.x, y: imagePoint.y });

      this.preview = new Polyline(
        [
          { x: imagePoint.x, y: imagePoint.y },
          { x: imagePoint.x, y: imagePoint.y },
        ],
        {
          fill: 'transparent',
          stroke: 'rgba(0,0,0,0.5)',
          strokeWidth: 2 / this.overlay.canvas.getZoom(),
          strokeDashArray: [5 / this.overlay.canvas.getZoom(), 5 / this.overlay.canvas.getZoom()],
          selectable: false,
          evented: false,
          strokeUniform: true,
          objectCaching: false,
        },
      );
      this.overlay.canvas.add(this.preview);
    } else {
      // Check if clicking near the first point to close
      if (this.vertices.length >= 3 && this.isNearFirstPoint(imagePoint)) {
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
    this.overlay.canvas.requestRenderAll();
  }

  onPointerUp(_event: PointerEvent, _imagePoint: Point): void {
    // No-op — path tool uses click (not drag) to add points
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

    const toolConstraint = this.callbacks.getToolConstraint(this.type);
    const style: AnnotationStyle = {
      ...DEFAULT_ANNOTATION_STYLE,
      ...toolConstraint?.defaultStyle,
    };

    const id = createAnnotationId(generateId());
    const options = getFabricOptions(style, id);
    const pts = this.vertices.map((p) => ({ x: p.x, y: p.y }));

    // Remove preview polyline
    if (this.preview) {
      this.overlay.canvas.remove(this.preview);
    }

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
  }

  cancel(): void {
    if (this.overlay && this.preview) {
      this.overlay.canvas.remove(this.preview);
      this.overlay.canvas.requestRenderAll();
    }
    this.preview = null;
    this.vertices = [];
  }
}
