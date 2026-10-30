import { FabricObject } from 'fabric';
import { BaseTool, type ToolCallbacks } from './base-tool.js';
import type { AnnotationId, Point } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import type { ToolOverlay } from '../types.js';
import { configureGroupSelection, isGroupSelection } from '../group-selection.js';
import {
  PolyVertexEditor,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  type VertexEditConfig,
} from '../poly-vertex-editor.js';
/**
 * Whether `object` is locked against moving, as a mask is. It must not join a
 * multi-selection; see {@link SelectTool}.
 */
function isTransformLocked(object: FabricObject): boolean {
  return object.lockMovementX && object.lockMovementY;
}

interface SelectionClearedEvent {
  readonly deselected: FabricObject[];
  readonly e?: Event;
}

/**
 * Selects, moves, resizes and rotates annotations, one at a time or several
 * together.
 *
 * Group selection — a drag-box from empty canvas, or Shift+click — is this
 * tool's alone: it turns the canvas's `selection` flag on while active and off
 * when deactivated, so a drag with a drawing tool never selects the shapes it
 * crosses. Every multi-selection Fabric makes is passed through
 * {@link configureGroupSelection}, so it can be moved, rotated and scaled
 * uniformly but never stretched or skewed.
 *
 * An object locked against moving (a mask: painting is the only way to change
 * one) never joins a multi-selection. Fabric checks only the transform
 * target's locks, and a multi-selection's target is the group, so a locked
 * member moved, scaled and rotated with it while its annotation stayed where
 * it was. It is dropped from the selection as the selection forms; selected
 * on its own, it can still be deleted.
 */
export class SelectTool extends BaseTool {
  readonly type = 'select' as const;

  private readonly editor: PolyVertexEditor;

  private readonly handleSelectionChanged = () => this.onSelectionChanged();
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

    this.overlay.canvas.selection = true;
    this.overlay.canvas.on('selection:created', this.handleSelectionChanged);
    this.overlay.canvas.on('selection:updated', this.handleSelectionChanged);
    this.overlay.canvas.on('selection:cleared', this.handleSelectionCleared);
    this.editor.activate(this.overlay);
  }

  deactivate(): void {
    this.editor.deactivate();
    if (this.overlay) {
      this.overlay.canvas.off('selection:created', this.handleSelectionChanged);
      this.overlay.canvas.off('selection:updated', this.handleSelectionChanged);
      this.overlay.canvas.off('selection:cleared', this.handleSelectionCleared);

      this.overlay.canvas.discardActiveObject();
      this.overlay.canvas.selection = false;
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

  /**
   * Nothing of the select tool's own to undo: `FabricOverlay` has already put
   * back the object the press was moving, and an object the press selected
   * stays selected. Not {@link cancel}, which discards the selection. The
   * vertex editor still holds the press, in a long-press timer or handles
   * built for points the overlay has just restored.
   */
  onPointerCancel(_event: PointerEvent, _pressSeq: number): void {
    this.editor.onPointerCancel();
  }

  /**
   * On `selection:created` and `selection:updated`. Read from the canvas, not
   * the event: `selection:updated` lists only what was just added, so a
   * Shift+click that made a pair would otherwise name the second shape as the
   * selected annotation. Several selected annotations name none.
   */
  private onSelectionChanged() {
    const canvas = this.overlay?.canvas;
    if (!this.callbacks || !canvas) return;
    const formed = canvas.getActiveObject();
    if (formed && isGroupSelection(formed)) {
      const locked = formed.getObjects().filter(isTransformLocked);
      if (locked.length > 0) {
        // Before any transform: the selection has only just formed, so taking
        // a member out leaves it where it is. Re-selecting may fire
        // `selection:updated` again, which finds nothing locked.
        formed.remove(...locked);
        const rest = formed.getObjects();
        if (rest.length === 0) canvas.discardActiveObject();
        else if (rest.length === 1) canvas.setActiveObject(rest[0]!);
        canvas.requestRenderAll();
      }
    }
    const active = canvas.getActiveObject();
    if (active && isGroupSelection(active)) configureGroupSelection(active);
    const selected = canvas.getActiveObjects();
    const only = selected.length === 1 ? selected[0] : undefined;
    if (only) {
      const annotationId = only.id as AnnotationId | undefined;
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
