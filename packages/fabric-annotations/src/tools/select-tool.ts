import { FabricObject } from 'fabric';
import { BaseTool, type ToolCallbacks } from './base-tool.js';
import type { AnnotationId, Point } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import type { ToolOverlay } from '../types.js';
import {
  PolyVertexEditor,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  type VertexEditConfig,
} from '../poly-vertex-editor.js';
interface SelectionEvent {
  readonly selected: FabricObject[];
  readonly e?: Event;
}

interface SelectionClearedEvent {
  readonly deselected: FabricObject[];
  readonly e?: Event;
}

export class SelectTool extends BaseTool {
  readonly type = 'select' as const;

  private readonly editor: PolyVertexEditor;

  private readonly handleSelectionCreated = (e: SelectionEvent) => this.onSelectionCreated(e);
  private readonly handleSelectionCleared = (e: SelectionClearedEvent) =>
    this.onSelectionCleared(e);

  constructor(
    config: VertexEditConfig = {
      longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    },
  ) {
    super();
    this.editor = new PolyVertexEditor(config);
  }

  activate(
    overlay: ToolOverlay,
    imageId: ImageId,
    callbacks: ToolCallbacks,
    shortcuts: KeyboardShortcutMap,
  ): void {
    super.activate(overlay, imageId, callbacks, shortcuts);
    if (!this.overlay) return;

    this.overlay.canvas.on('selection:created', this.handleSelectionCreated);
    this.overlay.canvas.on('selection:updated', this.handleSelectionCreated);
    this.overlay.canvas.on('selection:cleared', this.handleSelectionCleared);
    this.editor.activate(this.overlay);
  }

  deactivate(): void {
    this.editor.deactivate();
    if (this.overlay) {
      this.overlay.canvas.off('selection:created', this.handleSelectionCreated);
      this.overlay.canvas.off('selection:updated', this.handleSelectionCreated);
      this.overlay.canvas.off('selection:cleared', this.handleSelectionCleared);

      this.overlay.canvas.discardActiveObject();
      this.overlay.canvas.requestRenderAll();
    }
    super.deactivate();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (this.editor.onKeyDown(event)) return true;
    return super.onKeyDown(event);
  }

  onPointerDown(_event: PointerEvent, _imagePoint: Point): void {}
  onPointerMove(_event: PointerEvent, _imagePoint: Point): void {}
  onPointerUp(_event: PointerEvent, _imagePoint: Point): void {}

  cancel(): void {
    this.overlay?.canvas.discardActiveObject();
    this.overlay?.canvas.requestRenderAll();
  }

  private onSelectionCreated(e: SelectionEvent) {
    if (!this.callbacks) return;
    const selected = e.selected || [];
    if (selected.length === 1) {
      const obj = selected[0]!;
      const annotationId = obj.id as AnnotationId | undefined;
      if (annotationId) {
        this.callbacks.setSelectedAnnotation(annotationId);
      }
    } else {
      this.callbacks.setSelectedAnnotation(null);
    }
  }

  private onSelectionCleared(_e: SelectionClearedEvent) {
    if (!this.callbacks) return;
    this.callbacks.setSelectedAnnotation(null);
  }
}
