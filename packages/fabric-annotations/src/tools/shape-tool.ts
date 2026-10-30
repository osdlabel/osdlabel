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
 * The smallest a drawn shape may be on screen, in CSS pixels, for the tool to
 * commit it. Measured as the tool says: a rectangle's shorter side, a
 * circle's diameter, a line's length, and for a polyline, polygon or
 * free-hand path the largest distance between two of its vertices.
 *
 * A shape that is smaller is discarded instead, its preview removed, and the
 * tool is ready for the next one: a drag-to-draw shape on release, such as
 * a click without a drag, and a path when it is finished, such as clicks at
 * one spot ended with a double click, Enter or `c`, or a stroke that never
 * leaves a 3 px spot. Committed, it would be an annotation the user cannot
 * see, yet one that carries decorations at an empty spot and counts toward
 * the context's `maxCount`.
 *
 * Screen pixels, not image pixels, so the minimum means the same at every
 * zoom: zoomed out, a 2 px slip spans many image pixels and is still a slip;
 * zoomed in, a deliberate 4 px drag may span less than one and is still a
 * shape. The size is taken in the view as it is when the shape is
 * finished. The point tool is exempt: a click is how a point is placed.
 */
export const MIN_SHAPE_SCREEN_PX = 3;

/**
 * Base class for tools that create annotations via a click-and-drag interaction.
 * Handles common lifecycle, state management, and canvas interaction.
 *
 * On release the preview becomes the annotation, unless
 * {@link ShapeTool.previewScreenSize} reports it under
 * {@link MIN_SHAPE_SCREEN_PX}, in which case the gesture is discarded.
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

    // Too small to see, such as a click without a drag: discard it rather
    // than store an invisible annotation that still counts toward maxCount.
    if (this.previewScreenSize(this.preview) < MIN_SHAPE_SCREEN_PX) {
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

  /**
   * How big the preview is on screen, in CSS pixels, for the
   * {@link MIN_SHAPE_SCREEN_PX} check on release: the smallest of the
   * dimensions that must each reach it (a rectangle's two sides, say).
   *
   * The default, `Infinity`, never discards. The point tool relies on it, and
   * so does any subclass written before the minimum existed, which keeps
   * committing what it drew. A tool whose shape can be drawn too small to see
   * overrides it, measuring with {@link BaseTool.screenDistance}.
   */
  protected previewScreenSize(_preview: T): number {
    return Infinity;
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
