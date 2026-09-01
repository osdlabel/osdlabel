import { FabricObject } from 'fabric';
import { BaseTool } from './base-tool.js';
import {
  type ToolType,
  type Point,
  type AnnotationStyle,
  createAnnotationId,
  generateId,
} from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import { type FabricShapeOptions, getFabricOptions } from '../fabric-utils.js';

/**
 * Base class for tools that create annotations via a click-and-drag interaction.
 * Handles common lifecycle, state management, and canvas interaction.
 */
export abstract class ShapeTool<T extends FabricObject> extends BaseTool {
  abstract override readonly type: ToolType;
  protected preview: T | null = null;
  protected startPoint: Point | null = null;
  protected activeContextId: AnnotationContextId | null = null;

  onPointerDown(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.imageId || !this.callbacks) return;

    // Fail fast: check constraints before starting
    const contextId = this.callbacks.getActiveContextId();
    if (!contextId) {
      console.warn('No active context, cannot create annotation');
      return;
    }
    if (!this.callbacks.canAddAnnotation(this.type)) return;

    this.activeContextId = contextId;
    this.startPoint = imagePoint;

    const style = this.resolveStyle();
    const id = createAnnotationId(generateId());
    const options = getFabricOptions(style, id);

    this.preview = this.createPreview(imagePoint, options, style);

    this.overlay.canvas.add(this.preview);
    this.overlay.canvas.requestRenderAll();
  }

  protected abstract createPreview(
    imagePoint: Point,
    options: FabricShapeOptions,
    style: AnnotationStyle,
  ): T;

  onPointerMove(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.preview || !this.startPoint) return;
    this.updatePreview(imagePoint, this.startPoint);
    this.overlay.canvas.requestRenderAll();
  }

  protected abstract updatePreview(imagePoint: Point, startPoint: Point): void;

  onPointerUp(_event: PointerEvent, _imagePoint: Point): void {
    if (
      !this.overlay ||
      !this.preview ||
      !this.startPoint ||
      !this.imageId ||
      !this.callbacks ||
      !this.activeContextId
    ) {
      this.cancel();
      return;
    }

    // Make the object interactive
    this.preview.set({ selectable: true, evented: true });
    this.preview.setCoords();

    this.callbacks.addAnnotation({
      fabricObject: this.preview,
      imageId: this.imageId,
      contextId: this.activeContextId,
      type: this.type,
    });

    this.preview = null;
    this.startPoint = null;
    this.activeContextId = null;
  }

  cancel(): void {
    if (this.overlay && this.preview) {
      this.overlay.canvas.remove(this.preview);
      this.overlay.canvas.requestRenderAll();
    }
    this.preview = null;
    this.startPoint = null;
    this.activeContextId = null;
  }
}
