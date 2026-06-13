import { Polygon, Rect } from 'fabric';
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
import type {
  SegmentationProvider,
  SegmentationImageRef,
  SegmentationPrompt,
  SegmentationPoint,
  SegmentationBox,
  SegmentationResult,
} from '@osdlabel/segmentation';
import { getFabricOptions } from '../fabric-utils.js';
import type { ToolOverlay } from '../types.js';
import type { ToolCallbacks } from './base-tool.js';

/** Drag distance (screen px) above which a pointer interaction counts as a box, not a click. */
const BOX_DRAG_THRESHOLD_SCREEN_PX = 4;

/** Configuration for {@link SegmentationTool}, supplied by the framework wrapper. */
export interface SegmentationToolConfig {
  /** The injected inference backend. */
  readonly provider: SegmentationProvider;
  /** Builds the per-image handle the provider operates on. */
  readonly getImageRef: (imageId: ImageId) => SegmentationImageRef;
}

/**
 * Interactive auto-segmentation tool (Segment Anything-style). The user prompts
 * with a box drag and/or foreground/background clicks; the injected
 * {@link SegmentationProvider} returns contours that are previewed live and
 * committed as a polygon annotation on the finish key.
 *
 * Inference is asynchronous and therefore does not commit state from the pointer
 * handlers: each prompt schedules a `segment` call whose result only updates a
 * non-interactive preview. State is committed synchronously on the finish key,
 * so the existing reducer/commit path is untouched. Stale results from
 * superseded prompts are dropped via a request sequence number + `AbortController`.
 */
export class SegmentationTool extends BaseTool {
  readonly type: ToolType = 'segmentation';

  private readonly provider: SegmentationProvider;
  private readonly getImageRef: (imageId: ImageId) => SegmentationImageRef;

  private imageRef: SegmentationImageRef | null = null;

  /** Accumulated foreground/background point prompts. */
  private points: SegmentationPoint[] = [];
  /** The most recent box prompt, if any. */
  private box: SegmentationBox | null = null;

  /** Live result preview (non-interactive). */
  private previewPolygon: Polygon | null = null;
  /** Rubber-band rectangle shown while dragging a box. */
  private boxPreview: Rect | null = null;
  /** The most recent successful inference result, awaiting commit. */
  private lastResult: SegmentationResult | null = null;

  // Pointer-drag tracking.
  private pointerIsDown = false;
  private dragging = false;
  private startImagePoint: Point | null = null;

  // Async coordination.
  private requestSeq = 0;
  private segmentController: AbortController | null = null;
  private prepareController: AbortController | null = null;

  constructor(config: SegmentationToolConfig) {
    super();
    this.provider = config.provider;
    this.getImageRef = config.getImageRef;
  }

  activate(
    overlay: ToolOverlay,
    imageId: ImageId,
    callbacks: ToolCallbacks,
    shortcuts: KeyboardShortcutMap,
  ): void {
    super.activate(overlay, imageId, callbacks, shortcuts);
    this.imageRef = this.getImageRef(imageId);
    // Kick off the (potentially expensive) per-image encode once, up front.
    this.prepareController = new AbortController();
    void this.provider.prepare(this.imageRef, this.prepareController.signal).catch(() => {
      // Preparation failure surfaces when the user prompts; nothing to do here.
    });
  }

  deactivate(): void {
    this.prepareController?.abort();
    this.prepareController = null;
    super.deactivate();
  }

  onPointerDown(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay) return;
    this.pointerIsDown = true;
    this.dragging = false;
    this.startImagePoint = { x: imagePoint.x, y: imagePoint.y };
  }

  onPointerMove(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.pointerIsDown || !this.startImagePoint) return;

    if (!this.dragging) {
      const startScreen = this.overlay.imageToScreen(this.startImagePoint);
      const currentScreen = this.overlay.imageToScreen(imagePoint);
      const dx = currentScreen.x - startScreen.x;
      const dy = currentScreen.y - startScreen.y;
      if (Math.sqrt(dx * dx + dy * dy) < BOX_DRAG_THRESHOLD_SCREEN_PX) return;
      this.dragging = true;
      this.boxPreview = this.createBoxPreview();
      this.overlay.canvas.add(this.boxPreview);
    }

    if (this.boxPreview && this.startImagePoint) {
      const rect = rectFromPoints(this.startImagePoint, imagePoint);
      this.boxPreview.set({ ...rect, dirty: true });
      this.overlay.canvas.requestRenderAll();
    }
  }

  onPointerUp(event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.pointerIsDown || !this.startImagePoint) return;
    this.pointerIsDown = false;

    if (this.dragging) {
      const rect = rectFromPoints(this.startImagePoint, imagePoint);
      this.box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      if (this.boxPreview) {
        this.overlay.canvas.remove(this.boxPreview);
        this.boxPreview = null;
      }
    } else {
      // A click adds a point prompt: background when the modifier (Alt) is held.
      const label = event.altKey ? 0 : 1;
      this.points.push({ x: imagePoint.x, y: imagePoint.y, label });
    }

    this.dragging = false;
    this.startImagePoint = null;
    this.overlay.canvas.requestRenderAll();
    void this.runSegment();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    const shortcuts = this.shortcuts;
    const hasPrompt = this.points.length > 0 || this.box !== null;

    if (shortcuts && hasPrompt) {
      if (event.key === shortcuts.polylineFinish) {
        this.commit();
        return true;
      }
      if (event.key === shortcuts.polylineCancel) {
        this.cancel();
        return true;
      }
    }
    return super.onKeyDown(event);
  }

  private async runSegment(): Promise<void> {
    if (!this.imageRef) return;
    if (this.points.length === 0 && !this.box) return;

    const prompt: SegmentationPrompt = {
      ...(this.box ? { box: this.box } : {}),
      ...(this.points.length > 0 ? { points: [...this.points] } : {}),
    };

    const seq = ++this.requestSeq;
    this.segmentController?.abort();
    const controller = new AbortController();
    this.segmentController = controller;

    try {
      const result = await this.provider.segment(this.imageRef, prompt, controller.signal);
      if (seq !== this.requestSeq || controller.signal.aborted) return;
      this.lastResult = result;
      this.renderPreview(result);
    } catch {
      // Aborted or failed prompts leave the previous preview in place.
    }
  }

  private renderPreview(result: SegmentationResult): void {
    if (!this.overlay) return;
    if (this.previewPolygon) {
      this.overlay.canvas.remove(this.previewPolygon);
      this.previewPolygon = null;
    }
    const ring = largestRing(result.contours);
    if (!ring || ring.length < 3) {
      this.overlay.canvas.requestRenderAll();
      return;
    }
    const zoom = this.overlay.canvas.getZoom();
    this.previewPolygon = new Polygon(
      ring.map((p) => ({ x: p.x, y: p.y })),
      {
        fill: 'rgba(0, 120, 255, 0.25)',
        stroke: 'rgba(0, 120, 255, 0.9)',
        strokeWidth: 2 / zoom,
        strokeDashArray: [5 / zoom, 5 / zoom],
        selectable: false,
        evented: false,
        strokeUniform: true,
        objectCaching: false,
      },
    );
    this.overlay.canvas.add(this.previewPolygon);
    this.overlay.canvas.requestRenderAll();
  }

  private createBoxPreview(): Rect {
    const zoom = this.overlay!.canvas.getZoom();
    return new Rect({
      left: this.startImagePoint!.x,
      top: this.startImagePoint!.y,
      width: 0,
      height: 0,
      fill: 'transparent',
      stroke: 'rgba(0, 120, 255, 0.9)',
      strokeWidth: 2 / zoom,
      strokeDashArray: [5 / zoom, 5 / zoom],
      selectable: false,
      evented: false,
      strokeUniform: true,
      objectCaching: false,
    });
  }

  private commit(): void {
    if (!this.overlay || !this.imageId || !this.callbacks) {
      this.cancel();
      return;
    }
    const ring = this.lastResult ? largestRing(this.lastResult.contours) : null;
    if (!ring || ring.length < 3) {
      this.cancel();
      return;
    }

    const activeContextId = this.callbacks.getActiveContextId();
    if (!activeContextId || !this.callbacks.canAddAnnotation(this.type)) {
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

    if (this.previewPolygon) {
      this.overlay.canvas.remove(this.previewPolygon);
      this.previewPolygon = null;
    }

    const finalObj = new Polygon(
      ring.map((p) => ({ x: p.x, y: p.y })),
      { ...options, selectable: true, evented: true },
    );
    this.overlay.canvas.add(finalObj);
    this.overlay.canvas.requestRenderAll();

    this.callbacks.addAnnotation({
      fabricObject: finalObj,
      imageId: this.imageId,
      contextId: activeContextId,
      type: this.type,
    });

    this.resetPrompt();
  }

  cancel(): void {
    this.segmentController?.abort();
    this.segmentController = null;
    if (this.overlay) {
      if (this.previewPolygon) this.overlay.canvas.remove(this.previewPolygon);
      if (this.boxPreview) this.overlay.canvas.remove(this.boxPreview);
      this.overlay.canvas.requestRenderAll();
    }
    this.previewPolygon = null;
    this.boxPreview = null;
    this.resetPrompt();
  }

  private resetPrompt(): void {
    this.points = [];
    this.box = null;
    this.lastResult = null;
    this.pointerIsDown = false;
    this.dragging = false;
    this.startImagePoint = null;
  }
}

/** Returns the largest ring by point count, or null when there are no contours. */
function largestRing(contours: SegmentationResult['contours']): readonly Point[] | null {
  let best: readonly Point[] | null = null;
  for (const ring of contours) {
    if (!best || ring.length > best.length) best = ring;
  }
  return best;
}

/** Builds an axis-aligned `{ left, top, width, height }` rect from two corners. */
function rectFromPoints(
  a: Point,
  b: Point,
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
