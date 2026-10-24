import { Polygon, Rect, type FabricObject } from 'fabric';
import {
  createAnnotationId,
  generateId,
  type Point,
  type ToolType,
} from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId, KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { BaseTool, getFabricOptions, type ToolCallbacks, type ToolOverlay } from '@osdlabel/fabric-annotations';
import { MaskCapacityExceededError, type MaskSnapshot } from '@osdlabel/mask';
import { signedArea, type PolygonWithHoles } from '@osdlabel/mask-contour';
import {
  rankCandidates,
  rasterToMaskSnapshot,
  rasterToPolygons,
  type CandidateRanking,
  type MaskCandidate,
  type PromptBox,
  type PromptPoint,
  type SegmentationPrompt,
  type SegmentationProvider,
  type SegmentationResult,
  type SegmentationTarget,
} from '@osdlabel/segmentation';

/** A finished mask result, handed to the host to persist (as the brush does). */
export interface SegmentationMaskCommit {
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  readonly snapshot: MaskSnapshot;
  readonly predictedIou: number;
}

export type SegmentationOutput = 'mask' | 'polygon';

/** Instrumentation; the PoC harness records these. */
export type SegmentationToolEvent =
  | {
      readonly type: 'result';
      readonly result: SegmentationResult;
      /** pointer-up (or prompt change) -> provider result, ms. */
      readonly latency: number;
      /** Raster -> preview polygons, ms. */
      readonly previewBuild: number;
      readonly previewVertices: number;
    }
  | { readonly type: 'painted'; readonly latency: number }
  | {
      readonly type: 'commit';
      readonly output: SegmentationOutput;
      /** Conversion time (raster -> snapshot or polygon), ms. */
      readonly convert: number;
      readonly pixels?: number | undefined;
      readonly boxPixels?: number | undefined;
      readonly vertices?: number | undefined;
      readonly droppedRings?: number | undefined;
      readonly droppedHoles?: number | undefined;
    }
  | { readonly type: 'capacity'; readonly error: MaskCapacityExceededError }
  | { readonly type: 'error'; readonly error: unknown };

export interface SegmentationToolConfig {
  readonly provider: SegmentationProvider;
  /** Where the user is looking right now; `null` before the image opens. */
  readonly getTarget: () => SegmentationTarget | null;
  /** Default `'mask'`: a #149 mask annotation. `'polygon'` commits a polygon annotation. */
  readonly getOutput?: (() => SegmentationOutput) | undefined;
  readonly ranking?: CandidateRanking | undefined;
  /** Persists a mask result. Required for the mask output. */
  readonly onCommitMask?: ((commit: SegmentationMaskCommit) => void) | undefined;
  /**
   * When a mask would exceed `maxPixels` (a coarse encode on a huge image),
   * commit a polygon instead (default true) — the polygon is resolution
   * independent, the dense mask is not.
   */
  readonly fallbackToPolygon?: boolean | undefined;
  readonly maxPixels?: number | undefined;
  /**
   * Tool type recorded on polygon commits. `'polyline'` works today (its
   * geometry is read from the Fabric object, so a closed `Polygon` becomes a
   * polygon annotation), at the cost of counting against the polyline quota.
   */
  readonly polygonToolType?: ToolType | undefined;
  readonly onEvent?: ((event: SegmentationToolEvent) => void) | undefined;
}

const DRAG_THRESHOLD_PX = 4;
const PREVIEW_STYLE = {
  fill: 'rgba(255, 152, 0, 0.30)',
  stroke: 'rgba(255, 152, 0, 0.95)',
};

/**
 * SAM-style assisted segmentation: click to add a foreground point
 * (Alt/Shift-click for background), drag for a box, Enter to commit, Escape
 * to discard. Inference is asynchronous and never touches state; only the
 * commit does, through the same paths the brush (masks) and the vector tools
 * (polygons) use.
 *
 * The preview is the result's iso-contour drawn as Fabric polygons: computed
 * from the low-res logits (cost independent of zoom), crisp at any zoom,
 * and cheap to replace on every prompt.
 */
export class SegmentationTool extends BaseTool {
  readonly type: ToolType;
  private readonly config: SegmentationToolConfig;

  private points: PromptPoint[] = [];
  private box: PromptBox | null = null;
  private best: MaskCandidate | null = null;
  private lastResult: SegmentationResult | null = null;

  private preview: FabricObject[] = [];
  private boxPreview: Rect | null = null;
  private down: { screen: Point; image: Point } | null = null;
  private dragging = false;

  private seq = 0;
  private controller: AbortController | null = null;
  private promptStartedAt = 0;

  constructor(config: SegmentationToolConfig, toolType: ToolType = 'segmentation') {
    super();
    this.config = config;
    // 'segmentation' is the ToolType this PoC adds to @osdlabel/annotation (a
    // closed union: adding it touched annotation, validation, osdlabel and both
    // toolbars). Mask commits are counted against it by the host
    // (createMaskAnnotation's `toolType`); polygon commits use `polygonToolType`.
    this.type = toolType;
  }

  activate(overlay: ToolOverlay, imageId: ImageId, callbacks: ToolCallbacks, shortcuts: KeyboardShortcutMap): void {
    super.activate(overlay, imageId, callbacks, shortcuts);
    this.prepare();
  }

  /** Starts encoding the current view ahead of the first click (call on viewport settle). */
  prepare(): Promise<void> {
    const target = this.config.getTarget();
    if (!target || !this.config.provider.prepare) return Promise.resolve();
    return this.config.provider.prepare(target, new AbortController().signal).catch((error: unknown) => {
      this.config.onEvent?.({ type: 'error', error });
    });
  }

  /** The current best candidate (for tests and the harness). */
  get currentCandidate(): MaskCandidate | null {
    return this.best;
  }

  onPointerDown(event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay) return;
    this.down = { screen: this.overlay.imageToScreen(imagePoint), image: imagePoint };
    this.dragging = false;
    void event;
  }

  onPointerMove(_event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.down) return;
    const s = this.overlay.imageToScreen(imagePoint);
    if (!this.dragging && Math.hypot(s.x - this.down.screen.x, s.y - this.down.screen.y) < DRAG_THRESHOLD_PX) return;
    this.dragging = true;
    const r = rectOf(this.down.image, imagePoint);
    if (!this.boxPreview) {
      this.boxPreview = new Rect({
        ...r,
        fill: 'transparent',
        stroke: PREVIEW_STYLE.stroke,
        strokeWidth: 2,
        strokeUniform: true,
        strokeDashArray: [6, 4],
        selectable: false,
        evented: false,
        objectCaching: false,
      });
      this.boxPreview._readOnly = true;
      this.overlay.canvas.add(this.boxPreview);
    } else {
      this.boxPreview.set(r);
    }
    this.overlay.canvas.requestRenderAll();
  }

  onPointerUp(event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.down) return;
    if (this.dragging) {
      const r = rectOf(this.down.image, imagePoint);
      this.box = { x: r.left, y: r.top, width: r.width, height: r.height };
      if (this.boxPreview) {
        this.overlay.canvas.remove(this.boxPreview);
        this.boxPreview = null;
      }
    } else {
      this.points.push({ x: imagePoint.x, y: imagePoint.y, label: event.altKey || event.shiftKey ? 0 : 1 });
    }
    this.down = null;
    this.dragging = false;
    void this.run();
  }

  /** Adds a prompt programmatically (harness / keyboard-free tests). */
  addPoint(p: PromptPoint): Promise<void> {
    this.points.push(p);
    return this.run();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Enter' && this.best) {
      this.commit();
      return true;
    }
    if (event.key === 'Escape' && (this.points.length > 0 || this.box)) {
      this.cancel();
      return true;
    }
    return super.onKeyDown(event);
  }

  private async run(): Promise<void> {
    const target = this.config.getTarget();
    if (!target || (this.points.length === 0 && !this.box)) return;
    const prompt: SegmentationPrompt = {
      ...(this.points.length > 0 ? { points: [...this.points] } : {}),
      ...(this.box ? { box: this.box } : {}),
      // Refining with more clicks: feed the previous logits back (SAM mask_input).
      ...(this.best && this.points.length > 1 ? { previous: this.best.mask } : {}),
    };
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const seq = ++this.seq;
    this.promptStartedAt = performance.now();
    try {
      const result = await this.config.provider.segment(target, prompt, controller.signal);
      if (seq !== this.seq) return;
      const latency = performance.now() - this.promptStartedAt;
      const ranked = rankCandidates(result.candidates, this.config.ranking ?? 'iou');
      this.best = ranked[0] ?? null;
      this.lastResult = result;
      const t0 = performance.now();
      const polys = this.best ? this.previewPolygons(this.best, target) : [];
      const previewBuild = performance.now() - t0;
      this.config.onEvent?.({
        type: 'result',
        result,
        latency,
        previewBuild,
        previewVertices: polys.reduce((s, p) => s + p.outer.length + p.holes.reduce((h, r) => h + r.length, 0), 0),
      });
      this.drawPreview(polys);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.config.onEvent?.({ type: 'error', error });
    }
  }

  private previewPolygons(candidate: MaskCandidate, target: SegmentationTarget): PolygonWithHoles[] {
    // Simplify to about one screen pixel: invisible, and keeps Fabric cheap.
    const tolerance = 1 / Math.max(target.viewportScale, 1e-9);
    return rasterToPolygons(candidate.mask, { tolerance });
  }

  private drawPreview(polys: readonly PolygonWithHoles[]): void {
    const ov = this.overlay;
    if (!ov) return;
    for (const o of this.preview) ov.canvas.remove(o);
    this.preview = [];
    for (const p of polys) {
      // Holes are drawn as separate outlines; the preview only has to read well.
      for (const ring of [p.outer, ...p.holes]) {
        const poly = new Polygon(
          ring.map((v) => ({ x: v.x, y: v.y })),
          {
            fill: signedArea(ring) > 0 ? PREVIEW_STYLE.fill : 'rgba(0,0,0,0)',
            stroke: PREVIEW_STYLE.stroke,
            strokeWidth: 1.5,
            strokeUniform: true,
            selectable: false,
            evented: false,
            objectCaching: false,
          },
        );
        poly._readOnly = true;
        this.preview.push(poly);
        ov.canvas.add(poly);
      }
    }
    ov.canvas.requestRenderAll();
    const started = this.promptStartedAt;
    requestAnimationFrame(() => {
      this.config.onEvent?.({ type: 'painted', latency: performance.now() - started });
    });
  }

  /**
   * Commits the current best candidate as `output` (default: the configured
   * output). Returns what was committed — a mask that exceeds the cap may
   * become a polygon — or null.
   */
  commit(outputOverride?: SegmentationOutput): SegmentationOutput | null {
    const ov = this.overlay;
    const cb = this.callbacks;
    const best = this.best;
    const target = this.config.getTarget();
    if (!ov || !cb || !best || !this.imageId || !target) return null;
    const contextId = cb.getActiveContextId();
    if (!contextId) return null;
    const output: SegmentationOutput = outputOverride ?? this.config.getOutput?.() ?? 'mask';

    if (output === 'mask') {
      if (!cb.canAddAnnotation(this.type) || !this.config.onCommitMask) return null;
      const t0 = performance.now();
      try {
        const snapshot = rasterToMaskSnapshot(best.mask, target.imageSize, {
          ...(this.config.maxPixels !== undefined ? { maxPixels: this.config.maxPixels } : {}),
        });
        const convert = performance.now() - t0;
        this.config.onCommitMask({ imageId: this.imageId, contextId, snapshot, predictedIou: best.predictedIou });
        let pixels = 0;
        for (let i = 0; i < snapshot.data.length; i++) pixels += snapshot.data[i]!;
        this.config.onEvent?.({
          type: 'commit',
          output,
          convert,
          pixels,
          boxPixels: snapshot.width * snapshot.height,
        });
        this.clearPrompt();
        return output;
      } catch (error) {
        if (!(error instanceof MaskCapacityExceededError)) throw error;
        this.config.onEvent?.({ type: 'capacity', error });
        if (this.config.fallbackToPolygon === false) return null;
        // Fall through to the polygon output below.
      }
    }

    const polygonType = this.config.polygonToolType ?? 'polyline';
    if (!cb.canAddAnnotation(polygonType)) return null;
    const t0 = performance.now();
    // Commit at a quarter of a raster pixel: the polygon is the annotation now.
    const f = best.mask.frame;
    const polys = rasterToPolygons(best.mask, { tolerance: 0.25 * Math.min(f.pixelWidth, f.pixelHeight) });
    const convert = performance.now() - t0;
    const main = polys[0];
    if (!main) return null;
    const style = this.resolveStyleFor(polygonType);
    const id = createAnnotationId(generateId());
    const obj = new Polygon(
      main.outer.map((v) => ({ x: v.x, y: v.y })),
      { ...getFabricOptions(style, id), selectable: true, evented: true },
    );
    ov.canvas.add(obj);
    cb.addAnnotation({ fabricObject: obj, imageId: this.imageId, contextId, type: polygonType });
    this.config.onEvent?.({
      type: 'commit',
      output: 'polygon',
      convert,
      vertices: main.outer.length,
      droppedRings: polys.length - 1,
      droppedHoles: main.holes.length,
    });
    this.clearPrompt();
    return 'polygon';
  }

  private resolveStyleFor(type: ToolType) {
    const constraint = this.callbacks?.getToolConstraint(type);
    return { ...this.resolveStyle(), ...constraint?.defaultStyle };
  }

  cancel(): void {
    this.clearPrompt();
  }

  /** The last provider result (harness access). */
  get result(): SegmentationResult | null {
    return this.lastResult;
  }

  private clearPrompt(): void {
    this.controller?.abort();
    this.controller = null;
    this.seq++;
    const ov = this.overlay;
    if (ov) {
      for (const o of this.preview) ov.canvas.remove(o);
      if (this.boxPreview) ov.canvas.remove(this.boxPreview);
      ov.canvas.requestRenderAll();
    }
    this.preview = [];
    this.boxPreview = null;
    this.points = [];
    this.box = null;
    this.best = null;
    this.lastResult = null;
    this.down = null;
    this.dragging = false;
  }
}

function rectOf(a: Point, b: Point): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}
