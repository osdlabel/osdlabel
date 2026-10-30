import { FabricObject } from 'fabric';
import type { ToolOverlay } from '../types.js';
import {
  DEFAULT_ANNOTATION_STYLE,
  type ToolType,
  type Point,
  type AnnotationId,
  type AnnotationStyle,
  type BaseAnnotation,
} from '@osdlabel/annotation';
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

  /**
   * Handle a double click. Optional — {@link BaseTool} supplies a no-op.
   *
   * Does not arrive through {@link onPointerDown}: `PointerEvent.detail` is 0
   * on every forwarded event, so the overlay detects the gesture and reports it
   * separately (issue #168).
   *
   * Fires last: both of the gesture's `onPointerDown`s and the second
   * `onPointerUp` have already run by the time this is called.
   */
  onDoubleClick?(
    event: PointerEvent,
    imagePoint: Point,
    /** Sequences of the two presses that formed the pair; see {@link ToolOverlay.pressSeqOf}. */
    pressSeqs?: readonly [number, number],
  ): void;

  /**
   * The platform cancelled the press in progress (`pointercancel`: an OS
   * gesture, palm rejection, a system dialog), so undo what that press began.
   * `FabricOverlay` also cancels a touch press itself when a pen or a mouse
   * presses during it (a touch never wins over either: the touch was a hand
   * at rest), and `event` is then that pointer's `pointerdown`: its type,
   * `pointerId` and `pointerType` are not the cancelled press's, so identify
   * the press by `pressSeq`.
   * Optional — {@link BaseTool} supplies a default that calls {@link cancel},
   * which is right for a tool whose drawing lasts from press to release.
   *
   * `FabricOverlay` has already put back any object Fabric was moving,
   * scaling or rotating. It then ends Fabric's gesture with a release that
   * commits nothing, and that release arrives at {@link onPointerUp} *after*
   * this call — so a tool that commits on the release must have dropped its
   * preview here. A tool whose drawing spans several presses undoes only the
   * cancelled press's part, which `pressSeq` identifies: it is the sequence
   * {@link ToolOverlay.pressSeqOf} gave that press.
   */
  onPointerCancel?(event: PointerEvent, pressSeq: number): void;

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

  /**
   * The style new annotations of this tool's type are drawn with: the library
   * default merged with the active context's `ToolConstraint.defaultStyle`.
   * Tools must resolve the style through this so the in-progress preview and
   * the committed annotation always agree.
   */
  protected resolveStyle(): AnnotationStyle {
    const type = this.type;
    const toolConstraint = type === 'select' ? undefined : this.callbacks?.getToolConstraint(type);
    return { ...DEFAULT_ANNOTATION_STYLE, ...toolConstraint?.defaultStyle };
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

  /**
   * The distance on screen, in CSS pixels, between two image-space points.
   *
   * Taken through the overlay's `imageToScreen`, so it is exact under any
   * zoom, rotation or flip the view applies, and a tool needs nothing from
   * OpenSeaDragon to measure. `Infinity` while the tool is inactive, so a
   * size check made then never discards anything.
   */
  protected screenDistance(a: Point, b: Point): number {
    if (!this.overlay) return Infinity;
    const p = this.overlay.imageToScreen(a);
    const q = this.overlay.imageToScreen(b);
    return Math.hypot(q.x - p.x, q.y - p.y);
  }

  /**
   * Whether the path through `points` is smaller on screen than `minimum` CSS
   * pixels: every two of its points lie less than `minimum` apart, measured
   * with {@link BaseTool.screenDistance}, in the view as it is now. Such a
   * path paints no larger than a dot of that size, however many points it
   * has or whichever of them it starts from.
   *
   * It stops at the first two points that are far enough apart, so a path of
   * any real size is judged from its first few points.
   */
  protected isSmallerOnScreenThan(points: readonly Point[], minimum: number): boolean {
    for (let i = 1; i < points.length; i++) {
      for (let j = 0; j < i; j++) {
        if (this.screenDistance(points[j]!, points[i]!) >= minimum) return false;
      }
    }
    return true;
  }

  /** No-op by default; tools with a double-click gesture override this. */
  onDoubleClick(_event: PointerEvent, _imagePoint: Point): void {}

  /**
   * Drops the drawing in progress by default: right for a tool whose drawing
   * is one press, drag and release. Tools that span presses, or that do not
   * draw, override it.
   */
  onPointerCancel(_event: PointerEvent, _pressSeq: number): void {
    this.cancel();
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
