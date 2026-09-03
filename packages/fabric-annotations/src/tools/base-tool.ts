import { FabricObject } from 'fabric';
import type { ToolOverlay } from '../types.js';
import type { ToolType, Point, AnnotationId, BaseAnnotation } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ToolConstraint } from '@osdlabel/annotation-context';
/** Parameters for adding an annotation via a tool */
export interface AddAnnotationParams {
  readonly fabricObject: FabricObject;
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  readonly type: ToolType;
  readonly label?: string;
}

/** Framework-agnostic callbacks that tools use to interact with application state */
export interface ToolCallbacks {
  readonly getActiveContextId: () => AnnotationContextId | null;
  readonly getToolConstraint: (type: ToolType) => ToolConstraint | undefined;
  readonly canAddAnnotation: (type: ToolType) => boolean;
  readonly addAnnotation: (params: AddAnnotationParams) => void;
  readonly updateAnnotation: (
    id: AnnotationId,
    imageId: ImageId,
    fabricObject: FabricObject,
  ) => void;
  readonly deleteAnnotation: (id: AnnotationId, imageId: ImageId) => void;
  readonly setSelectedAnnotation: (id: AnnotationId | null) => void;
  readonly getAnnotation: (id: AnnotationId, imageId: ImageId) => BaseAnnotation | undefined;
}

export interface AnnotationTool {
  /** Tool identifier */
  readonly type: ToolType | 'select';

  /** Called when the tool becomes active */
  activate(
    overlay: ToolOverlay,
    imageId: ImageId,
    callbacks: ToolCallbacks,
    shortcuts: KeyboardShortcutMap,
  ): void;

  /** Called when the tool is deactivated */
  deactivate(): void;

  /** Handle pointer down — start drawing */
  onPointerDown(event: PointerEvent, imagePoint: Point): void;

  /** Handle pointer move — update drawing preview */
  onPointerMove(event: PointerEvent, imagePoint: Point): void;

  /** Handle pointer up — commit the annotation */
  onPointerUp(event: PointerEvent, imagePoint: Point): void;

  /** Handle key down - returns true if the key was consumed */
  onKeyDown(event: KeyboardEvent): boolean;

  /** Cancel the current drawing interaction */
  cancel(): void;
}

export abstract class BaseTool implements AnnotationTool {
  abstract readonly type: ToolType | 'select';
  protected overlay: ToolOverlay | null = null;
  protected imageId: ImageId | null = null;
  protected callbacks: ToolCallbacks | null = null;
  protected shortcuts: KeyboardShortcutMap | null = null;

  activate(
    overlay: ToolOverlay,
    imageId: ImageId,
    callbacks: ToolCallbacks,
    shortcuts: KeyboardShortcutMap,
  ): void {
    this.overlay = overlay;
    this.imageId = imageId;
    this.callbacks = callbacks;
    this.shortcuts = shortcuts;
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (
      this.shortcuts &&
      (event.key === this.shortcuts.delete || event.key === this.shortcuts.deleteAlt)
    ) {
      // Claimed only when it actually deleted something. Returning `true`
      // unconditionally made the key dead whenever Fabric has no active
      // object but the app does have a selected annotation — which is *always*
      // the case in `paint` mode, where every object is inert and the
      // selection is discarded. The host's keyboard map deletes from
      // `UIState.selectedAnnotationId` instead, but only if this lets the
      // event through.
      return this.deleteSelected();
    }
    return false;
  }

  deactivate(): void {
    this.cancel();
    this.overlay = null;
    this.imageId = null;
    this.callbacks = null;
    this.shortcuts = null;
  }

  abstract onPointerDown(event: PointerEvent, imagePoint: Point): void;
  abstract onPointerMove(event: PointerEvent, imagePoint: Point): void;
  abstract onPointerUp(event: PointerEvent, imagePoint: Point): void;
  abstract cancel(): void;

  /** @returns whether anything was deleted. */
  private deleteSelected(): boolean {
    if (!this.callbacks || !this.imageId || !this.overlay) return false;
    const activeObjects = this.overlay.canvas.getActiveObjects().slice();
    if (activeObjects.length === 0) return false;

    // Discard selection first to prevent Fabric from errors when objects are removed
    this.overlay.canvas.discardActiveObject();
    this.overlay.canvas.requestRenderAll();

    let deleted = false;
    for (const obj of activeObjects) {
      const annotationId = obj.id as AnnotationId | undefined;
      if (annotationId) {
        this.callbacks.deleteAnnotation(annotationId, this.imageId);
        deleted = true;
      }
    }
    return deleted;
  }
}
