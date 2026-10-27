import { Circle, Color, FabricImage, Path, type FabricObject } from 'fabric';
import { BaseTool, type ToolCallbacks } from './base-tool.js';
import type { AnnotationId, Point, ToolType } from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId, KeyboardShortcutMap } from '@osdlabel/viewer-api';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MAX_MASK_DOWNSAMPLE,
  MaskCapacityExceededError,
  isMaskDownsample,
  majorityCoarsen,
  refineRaster,
  snapshotImageBox,
  stampCircle,
  strokeSegment,
  type CoarsenStrategy,
  type MaskBuffer,
  type MaskCellBox,
  type MaskRaster,
  type MaskRegion,
} from '@osdlabel/mask';
import { DEFAULT_MASK_FILL, packRgba } from '../mask-fabric-object.js';
import {
  MAX_MASK_CANVAS_SIDE,
  MaskCanvasTooLargeError,
  type BrushCapacityError,
} from '../mask-canvas-limit.js';
import type { ToolOverlay } from '../types.js';
import { describeThrown } from '../describe-thrown.js';
import { growPreviewBounds } from './margin-scale.js';

/** The painted result of one stroke, handed to the host to persist. */
export interface BrushStrokeCommit {
  /** Existing mask being refined, or `null` when the stroke created a new one. */
  readonly annotationId: AnnotationId | null;
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  /** The mask after the stroke, through the storage-agnostic raster interface. */
  readonly snapshot: MaskRaster;
  /**
   * The downsample the mask had before the stroke: the refined mask's, or 1
   * for a new one. `snapshot.downsample` is above it when the stroke coarsened
   * the mask to fit its cap, and below it when the stroke re-gridded it finer.
   */
  readonly startDownsample: number;
  /**
   * The mask as the stroke's live preview drew it, in `fill`: `crop()` gives
   * one canvas pixel per cell of `snapshot.cells`, or `null` if the engine
   * refuses the canvas. A host can show it without decoding and re-rasterizing
   * the mask (`maskFabricObjectFromCanvas`), the most expensive part of a
   * commit on a large mask. Cropped only when asked, so a host that cannot use
   * it — a tint it would not draw, a mask past its display budget — pays
   * nothing. Absent when there was no preview to crop.
   */
  readonly preview?:
    | { readonly fill: string; readonly crop: () => HTMLCanvasElement | null }
    | undefined;
}

/** What the next stroke would paint into, answered without resolving it. */
export interface BrushTargetPreview {
  /** The downsample of the mask it would refine. */
  readonly downsample: number;
  /**
   * The mask's box in image (level-0) pixels — its geometry's, no decode
   * needed. With it the cue shows the grid the stroke will paint on after
   * re-gridding finer; without it, the mask's own.
   */
  readonly box?: MaskRegion | undefined;
}

/** The mask a stroke should paint into, resolved by the host. */
export interface BrushTarget {
  readonly annotationId: AnnotationId;
  /** The mask to refine; any raster (`denseRaster` wraps a dense snapshot). */
  readonly snapshot: MaskRaster;
  /**
   * The tint this mask is already drawn with, if it recorded one.
   *
   * The stroke preview replaces the committed object for its duration, so
   * without this a mask saved in red would flash blue while being refined.
   * {@link SegmentationBrushToolConfig.getFill} takes precedence when a host
   * supplies one, since that names a colour for the stroke as a whole.
   */
  readonly fill?: string | undefined;
}

export interface SegmentationBrushToolConfig {
  /** Brush radius in **image** pixels, so a stroke means the same at any zoom. */
  readonly getBrushRadius: () => number;
  /** Full image size; painting is impossible until this is known. */
  readonly getImageSize: () => { width: number; height: number } | null;
  /**
   * The currently selected mask, if any. Returning it makes a stroke refine
   * that mask; returning `null` starts a new one.
   */
  readonly getTarget: () => BrushTarget | null;
  /** Persists a finished stroke (create or update). */
  readonly onCommit: (commit: BrushStrokeCommit) => void;
  /**
   * Whether the next stroke would refine a mask (and at what downsample) or
   * create one (`null`), without decoding anything: the cursor asks on every
   * pointer move, to draw a solid ring for refining and a dashed one for
   * creating. Omitted, the ring is drawn solid, as if refining. Must agree
   * with {@link SegmentationBrushToolConfig.getTarget}.
   */
  readonly peekTarget?: (() => BrushTargetPreview | null) | undefined;
  /**
   * Tint for painted pixels, overriding whatever the target mask recorded.
   *
   * Only reachable by building the config directly — the `Annotator` path does
   * not expose it — so by default a stroke keeps the colour of the mask it is
   * refining, falling back to {@link DEFAULT_MASK_FILL} for a new one.
   */
  readonly getFill?: (() => string) | undefined;
  /**
   * Host-driven eraser toggle. Erasing also happens while Alt is held, so this
   * is for a sticky toolbar toggle rather than the transient modifier.
   */
  readonly isErasing?: (() => boolean) | undefined;
  /**
   * Called when the user presses the resize keys. Only the direction is
   * reported — the host owns the step size and any clamping.
   */
  readonly onAdjustRadius?: ((direction: 1 | -1) => void) | undefined;
  /**
   * Called when a stroke is abandoned because the mask would grow past its
   * cell cap, or its live preview past what a canvas can draw.
   */
  readonly onCapacityExceeded?: ((error: BrushCapacityError) => void) | undefined;
  readonly maxPixels?: number | undefined;
  /**
   * The coarsest downsample a stroke may push its mask to when it would
   * outgrow the cap: on overflow the stroke's buffer is halved by the coarsen
   * strategy, its preview redrawn, and the segment painted again, until it fits
   * or this is reached, when the whole stroke is refused as it is without it.
   * A power of two; 1 (the default, and what any other value means) never
   * coarsens. Read at each press.
   */
  readonly getMaxDownsample?: (() => number) | undefined;
  /**
   * The rule a stroke coarsens by (default `majorityCoarsen`). Read at each
   * overflow, at most once per overflow between pointer events, so a slow host
   * strategy delays one segment rather than every one. It must meet the
   * contract `verifyCoarsenStrategy` checks.
   */
  readonly getCoarsenStrategy?: (() => CoarsenStrategy) | undefined;
}

/** The cursor cue's line width, in screen pixels whatever the zoom. */
const CURSOR_STROKE_SCREEN_PX = 1;
/** The dash of a cue for a stroke that will create a mask, in screen pixels. */
const CURSOR_DASH_SCREEN_PX = [5, 4] as const;

/** The cursor cue's look; never an annotation (no `id`), never interactive. */
const CURSOR_STYLE = {
  fill: 'transparent',
  stroke: 'rgba(255, 255, 255, 0.9)',
  strokeWidth: 1,
  strokeUniform: true,
  selectable: false,
  evented: false,
  _readOnly: true,
  objectCaching: false,
} as const;

/**
 * Freehand raster brush: paints (or erases) pixels into a mask annotation.
 *
 * Pixels are mutated in a plain buffer and mirrored onto an offscreen canvas
 * during the stroke, so nothing touches reactive state until the pointer is
 * released — one dispatch per stroke rather than one per pointer sample.
 *
 * Erasing is Alt-held (matching QuPath's brush) or a host-driven toggle,
 * expressed as painting with value `0` rather than as a separate mode.
 */
export class SegmentationBrushTool extends BaseTool {
  readonly type: ToolType = 'segmentationBrush';

  private readonly config: SegmentationBrushToolConfig;

  private buffer: MaskBuffer | null = null;
  private targetId: AnnotationId | null = null;
  private contextId: AnnotationContextId | null = null;

  /** Live rendering of the in-progress mask. */
  private preview: FabricImage | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewBounds: MaskRegion | null = null;
  /**
   * Persistent pixels for the preview canvas.
   *
   * Reallocating this per pointer move meant 16 MB of garbage per frame on a
   * 2000x2000 mask; keeping it lets each move touch only the pixels the stroke
   * actually swept.
   */
  private previewPixels: ImageData | null = null;
  /** Stroke tint, parsed once per stroke rather than per repaint. */
  private previewRgba: readonly [number, number, number, number] | null = null;
  /** The fill `previewRgba` was parsed from: what the preview's pixels are in. */
  private previewFill: string | null = null;
  /** The refined mask's own tint, so the preview does not recolour it. */
  private targetFill: string | undefined;

  /** Ring showing the brush footprint under the cursor. */
  private cursor: Circle | null = null;
  /**
   * At a downsample above 1, the outline of the cells a dab there would set,
   * shown instead of the ring: a circle would promise a precision the mask
   * does not have.
   */
  private cursorCells: Path | null = null;
  /** Where the cursor was last drawn, to redraw it when what it shows changes. */
  private cursorPoint: Point | null = null;
  /** The zoom the cue was last sized for, so a zoom without a move resizes it. */
  private cursorZoom: number | undefined;
  /**
   * A box, in cells, holding every cell the stroke's mask can have set: the
   * target's own box, grown by each region painted into. Tighter than the
   * buffer's allocation, which is rounded out to its growth chunks, so a mask
   * just under the canvas limit is not refused for its rounding.
   */
  private paintedBounds: MaskCellBox | null = null;
  /** The buffer's change count when the stroke began, to tell a no-op stroke. */
  private changesAtStart: number | undefined;
  /** The mask's downsample before the stroke, for the commit. */
  private startDownsample = 1;
  /** Why the last coarsening failed, when it threw rather than declined. */
  private coarsenFailure: unknown = undefined;
  /**
   * The overflow that last made this stroke coarsen, and whether the target
   * had cells when the stroke began: together they let the release refuse a
   * paint stroke that coarsened its target away (#243 Q1).
   */
  private lastOverflow: MaskCapacityExceededError | null = null;
  private targetHadCells = false;
  /** The coarsest downsample this stroke may coarsen to; 1 never coarsens. */
  private strokeMaxDownsample = 1;

  /**
   * The committed object for the mask being refined, hidden for the duration of
   * the stroke.
   *
   * The preview redraws the whole mask, so leaving the committed object visible
   * would paint both: the mask would darken to double alpha while painting, and
   * — worse — erased pixels would still be drawn underneath, so an erase looked
   * like nothing had happened until the pointer came up.
   */
  private hiddenTarget: FabricObject | null = null;
  /**
   * The target still to hide: its object was not on the canvas when the
   * stroke began. A press that commits the previous stroke rebuilds the
   * canvas, and the rebuilt objects land asynchronously, so the hide is
   * retried as the preview is drawn until the object appears.
   */
  private hiddenTargetId: AnnotationId | null = null;

  private painting = false;
  /** The pointer that started the stroke; moves and releases from any other are ignored. */
  private strokePointerId: number | null = null;
  private erasing = false;
  private lastPoint: Point | null = null;

  constructor(config: SegmentationBrushToolConfig) {
    super();
    this.config = config;
  }

  activate(
    overlay: ToolOverlay,
    imageId: ImageId,
    callbacks: ToolCallbacks,
    shortcuts: KeyboardShortcutMap,
  ): void {
    super.activate(overlay, imageId, callbacks, shortcuts);
    this.ensureCursor();
    overlay.canvas.on('before:render', this.onBeforeRender);
  }

  deactivate(): void {
    this.overlay?.canvas.off('before:render', this.onBeforeRender);
    this.removeCursor();
    super.deactivate();
  }

  /**
   * Redraws the cue when the zoom changed with no pointer move — a Ctrl/Cmd
   * scroll, the reset-view key — so it stays a fixed size on screen. Changes
   * to the objects here are drawn by the render under way.
   */
  private readonly onBeforeRender = (): void => {
    if (!this.cursorPoint || !this.overlay) return;
    if (this.overlay.canvas.getZoom() === this.cursorZoom) return;
    this.updateCursor(this.cursorPoint);
  };

  onPointerDown(event: PointerEvent, imagePoint: Point): void {
    if (!this.overlay || !this.imageId || !this.callbacks) return;

    // A stroke already in progress means its release never arrived: the
    // overlay forwards a missed release in every case it can see (a cancel, a
    // finger lifted while another rests), but a host driving the tool
    // directly may not. Those are finished pixels, so commit them rather than
    // throw them away. Ending the stroke here also keeps this one from
    // inheriting the old preview canvas: `syncPreview` would measure the new
    // buffer against stale bounds, find it fits, and leave the previous
    // stroke's pixels on screen for the whole of this one.
    if (this.painting) this.finishStroke();

    const imageSize = this.config.getImageSize();
    if (!imageSize) return;

    const contextId = this.callbacks.getActiveContextId();
    if (!contextId) return;

    // Refine the selected mask when there is one; otherwise start a new mask,
    // which is the point at which the tool's constraint applies.
    // Resolving the target decodes the mask being refined, and loading it
    // allocates — so both it and the buffer construction can hit the cap. Both
    // sit inside the handler for that: outside it, the error escaped into
    // Fabric's event dispatch on every pointer-down over that mask, with the
    // host's callback never firing.
    let target: BrushTarget | null;
    try {
      target = this.config.getTarget();
      if (!target && !this.callbacks.canAddAnnotation(this.type)) return;

      this.contextId = contextId;
      this.targetId = target?.annotationId ?? null;
      this.targetFill = target?.fill;

      // A new mask starts at full resolution whatever the zoom: choosing from
      // the view coarsened small strokes, and made the result depend on the
      // size of the monitor it was painted on. A refined one keeps its own
      // resolution, unless the view is close enough to paint it finer and the
      // finer box fits; re-gridding finer replicates cells, so it loses nothing.
      this.strokeMaxDownsample = this.maxDownsample();
      this.startDownsample = target?.snapshot.downsample ?? 1;
      // The refined mask's box, read from the raster the buffer loads rather
      // than from the buffer, whose `raster()` copies the whole mask (#243
      // minor 9).
      let targetCells: MaskCellBox | null = null;
      if (target) {
        const downsample = this.strokeDownsample(
          target.snapshot.downsample,
          snapshotImageBox(target.snapshot),
          imagePoint,
          this.strokeMaxDownsample,
        );
        const source =
          downsample < target.snapshot.downsample
            ? refineRaster(target.snapshot, downsample, this.capacity())
            : target.snapshot;
        this.buffer = BoundedDenseMaskBuffer.fromSnapshot(source, this.maxPixelsOption());
        targetCells = source.cells;
      } else {
        this.buffer = new BoundedDenseMaskBuffer({
          imageWidth: imageSize.width,
          imageHeight: imageSize.height,
          ...this.maxPixelsOption(),
        });
      }
      this.changesAtStart = this.buffer.changeCount;
      this.targetHadCells = targetCells !== null && targetCells.width > 0 && targetCells.height > 0;
      this.paintedBounds = this.targetHadCells && targetCells ? { ...targetCells } : null;
    } catch (error) {
      if (error instanceof MaskCapacityExceededError) {
        this.config.onCapacityExceeded?.(error);
        this.endStroke();
        return;
      }
      throw error;
    }

    this.painting = true;
    this.strokePointerId = event.pointerId ?? null;
    this.erasing = event.altKey || (this.config.isErasing?.() ?? false);
    this.lastPoint = imagePoint;
    if (this.targetId) this.hideCommittedTarget(this.targetId);
    // A tap paints a dot; it should show the ring it painted with.
    this.updateCursor(imagePoint);

    this.paint(
      () => stampCircle(this.buffer!, imagePoint.x, imagePoint.y, this.radius(), this.value()),
      this.discRegion(imagePoint.x, imagePoint.y),
      imagePoint,
      imagePoint,
    );
  }

  onPointerMove(event: PointerEvent, imagePoint: Point): void {
    // Fabric already drops non-primary pointers; this guards the host-driven
    // path, and a palm or second finger must never steer the stroke.
    if (this.painting && !this.isStrokePointer(event)) return;
    this.updateCursor(imagePoint);

    if (!this.painting || !this.buffer || !this.lastPoint) {
      this.overlay?.canvas.requestRenderAll();
      return;
    }

    // A move with the primary button up means the release was lost — a
    // `pointercancel` nothing forwarded, a finger lifted while another rested.
    // Painting on would draw with no button held until the next press.
    // `buttons` is unknown on a hand-built event, so only a definite 0 counts.
    if (event.buttons !== undefined && (event.buttons & 1) === 0) {
      this.finishStroke();
      return;
    }

    const from = this.lastPoint;
    this.lastPoint = imagePoint;
    this.paint(
      () =>
        strokeSegment(
          this.buffer!,
          from.x,
          from.y,
          imagePoint.x,
          imagePoint.y,
          this.radius(),
          this.value(),
        ),
      this.sweptRegion(from.x, from.y, imagePoint.x, imagePoint.y),
      from,
      imagePoint,
    );
  }

  onPointerUp(event: PointerEvent, _imagePoint: Point): void {
    if (this.painting && !this.isStrokePointer(event)) return;
    // The platform cancelled the press: a palm it rejected, or a system
    // gesture. That input was never meant for the page, so its pixels are
    // discarded rather than committed; on an iPad the palm landing before the
    // pencil otherwise left a dot in the mask.
    if (this.overlay?.isCancelledRelease?.(event) === true) this.cancel();
    else this.finishStroke();
    // A finger has nowhere to hover: a ring left at the lift point is an
    // artefact, not a cursor.
    if (event.pointerType === 'touch') this.hideCursor();
  }

  /** The pointer that started the stroke, or any pointer if none was recorded. */
  private isStrokePointer(event: PointerEvent): boolean {
    return (
      this.strokePointerId === null ||
      event.pointerId === undefined ||
      event.pointerId === this.strokePointerId
    );
  }

  /** Commits the stroke in progress, if there is one worth committing, and ends it. */
  private finishStroke(): void {
    if (!this.painting || !this.buffer || !this.imageId || !this.contextId) {
      this.endStroke();
      return;
    }

    // A stroke that changed no cell — painting over paint, erasing where there
    // was none — commits nothing: re-encoding an unchanged mask is the
    // expensive half of a commit, and it would mark the annotation updated.
    const changes = this.buffer.changeCount;
    if (changes !== undefined && changes === this.changesAtStart) {
      this.endStroke();
      return;
    }

    const snapshot = this.buffer.raster();
    // A paint stroke never empties its target: the empty result of one that
    // coarsened a sparse mask away (every feature smaller than a coarse cell)
    // and then painted nothing on the coarse grid would be committed under
    // the target's id, which the host reads as "erased to nothing" and
    // deletes (#243 Q1). Refused as the overflow that coarsened it.
    const overflow = this.lastOverflow;
    if (
      overflow &&
      !this.erasing &&
      this.targetHadCells &&
      (snapshot.cells.width === 0 || snapshot.cells.height === 0)
    ) {
      this.config.onCapacityExceeded?.(
        new MaskCapacityExceededError(
          overflow.requestedCells,
          overflow.maxCells,
          overflow.downsample,
          `Coarsening it to fit, to downsample ${snapshot.downsample}, would leave it empty: ` +
            `its features are smaller than a cell there. ${MaskCapacityExceededError.DEFAULT_ADVICE}`,
        ),
      );
      this.endStroke();
      return;
    }
    const preview = this.previewOf(snapshot.cells);
    const commit: BrushStrokeCommit = {
      annotationId: this.targetId,
      imageId: this.imageId,
      contextId: this.contextId,
      snapshot,
      startDownsample: this.startDownsample,
      ...(preview ? { preview } : {}),
    };
    this.endStroke();
    this.config.onCommit(commit);
  }

  /**
   * The live preview's pixels cut down to `cells`, the committed mask's box,
   * cropped when the host asks: one native copy, about 15 ms on a 4000-square
   * mask against 200–280 for a decode and re-raster (#238). `null` when there
   * is no preview or it does not cover the box.
   *
   * From the preview's own `ImageData`, not its canvas: an engine that refused
   * the preview canvas leaves it blank, and a crop of that seeded the cell
   * with an invisible mask (#243 P4). The fill is the one the pixels were
   * drawn in, recorded when the tint was parsed, not re-read at the release.
   */
  private previewOf(cells: MaskCellBox): BrushStrokeCommit['preview'] | null {
    const pixels = this.previewPixels;
    const bounds = this.previewBounds;
    if (!pixels || !bounds || cells.width === 0 || cells.height === 0) return null;
    if (
      cells.x < bounds.x ||
      cells.y < bounds.y ||
      cells.x + cells.width > bounds.x + bounds.width ||
      cells.y + cells.height > bounds.y + bounds.height
    ) {
      return null;
    }
    const fill = this.previewFill ?? this.strokeFill();
    let cropped: HTMLCanvasElement | null | undefined;
    const crop = (): HTMLCanvasElement | null => {
      if (cropped !== undefined) return cropped;
      cropped = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = cells.width;
        canvas.height = cells.height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        const dx = cells.x - bounds.x;
        const dy = cells.y - bounds.y;
        context.putImageData(pixels, -dx, -dy, dx, dy, cells.width, cells.height);
        cropped = canvas;
      } catch {
        // A refused canvas only costs the host its shortcut: it re-rasterizes.
      }
      return cropped;
    };
    return { fill, crop };
  }

  onKeyDown(event: KeyboardEvent): boolean {
    // This runs before the global shortcut map, so anything consumed here is
    // taken away from it. The resize keys share their defaults with the
    // grid-row shortcuts, and are claimed for the whole time the brush is the
    // active tool — resizing between strokes is the common case, and while the
    // brush is selected that is far likelier to be what the user meant than
    // resizing the grid. Both come from the shortcut map, so a consumer who
    // disagrees can rebind either side.
    if (this.config.onAdjustRadius && this.shortcuts) {
      if (event.key === this.shortcuts.increaseBrushRadius) {
        this.config.onAdjustRadius(1);
        this.refreshCursor();
        return true;
      }
      if (event.key === this.shortcuts.decreaseBrushRadius) {
        this.config.onAdjustRadius(-1);
        this.refreshCursor();
        return true;
      }
    }
    // New mask and cancel change what the next stroke paints into, and the
    // host applies them after this handler returns: redraw the cue then,
    // rather than leave it stale until the pointer moves.
    // Shift with the New mask key is another shortcut (toggleNegative), as
    // the keyboard map decides it.
    const isNewMask =
      this.shortcuts !== null &&
      !event.shiftKey &&
      event.key.toLowerCase() === this.shortcuts.newMask.toLowerCase();
    if (!this.painting && this.shortcuts && (isNewMask || event.key === this.shortcuts.cancel)) {
      queueMicrotask(() => this.refreshCursor());
    }
    if (this.painting && this.shortcuts) {
      if (event.key === this.shortcuts.cancel) {
        this.cancel();
        return true;
      }
      // Deleting the mask being refined mid-stroke would leave the stroke
      // with nothing to commit into, so the key is ignored while a stroke is
      // open: press it again after releasing.
      if (event.key === this.shortcuts.delete || event.key === this.shortcuts.deleteAlt) {
        return true;
      }
      // New mask mid-stroke would deselect the mask being refined; at the
      // limit that disabled the brush and tore the stroke down unsaved.
      // Ignored while the stroke is open, like Delete.
      if (isNewMask) {
        return true;
      }
    }
    return super.onKeyDown(event);
  }

  cancel(): void {
    this.endStroke();
  }

  // ── Painting ─────────────────────────────────────────────────────────────

  private radius(): number {
    return Math.max(0.1, this.config.getBrushRadius());
  }

  private value(): 0 | 1 {
    return this.erasing ? 0 : 1;
  }

  private maxPixelsOption(): { maxPixels?: number } {
    // Screened, not just forwarded. The buffer raises a plain `RangeError` for
    // a non-positive or non-finite cap, which is not the
    // `MaskCapacityExceededError` the stroke knows how to abandon — so a bad
    // value escaped into Fabric's dispatch on every pointer-down. Ignoring it
    // falls back to the default cap, which is how the tool treats every other
    // unusable input.
    //
    // Clamped to the format's cap as `buildSegmentationBrushConfig` does: a
    // host driving the tool directly could otherwise paint a mask that no
    // encoder will write and no reader will load.
    const cap = this.config.maxPixels;
    return cap !== undefined && Number.isFinite(cap) && cap > 0
      ? { maxPixels: Math.min(cap, DEFAULT_MAX_MASK_PIXELS) }
      : {};
  }

  /** The cell cap a stroke's buffer is held to. */
  private capacity(): number {
    return this.maxPixelsOption().maxPixels ?? DEFAULT_MAX_MASK_PIXELS;
  }

  /** The host's `maxDownsample`, screened: a power of two, else 1. */
  private maxDownsample(): number {
    const value = this.config.getMaxDownsample?.();
    return value !== undefined && isMaskDownsample(value) ? value : 1;
  }

  /**
   * The downsample a stroke pressed at `point` paints a `downsample` mask at:
   * the finest power of two no finer than the view shows (an image pixel per
   * screen pixel or more), whose box — the mask's, `box` in image pixels, and
   * the first dab's — fits, with no side longer than a canvas draws. A
   * context that coarsens (`maxDownsample` above 1) may fill the cap; one that
   * does not keeps three quarters of it free. A stroke that outgrows the cap
   * or the canvas side anyway coarsens back toward the mask's own grid (see
   * `coarsenBuffer`), so re-gridding never turns a stroke that would have
   * fitted at the mask's own resolution into a refusal. The mask's own
   * downsample when nothing finer fits.
   */
  private strokeDownsample(
    downsample: number,
    box: MaskRegion,
    point: Point,
    maxDownsample: number,
  ): number {
    if (downsample <= 1 || !this.overlay) return downsample;
    const size = this.config.getImageSize();
    const zoom = this.overlay.canvas.getZoom();
    const perScreenPixel = Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;
    let finest = 1;
    // With a relative tolerance: a view at exactly 4 image pixels a screen
    // pixel reads a zoom of 0.24999999999994 or 0.2500000000001 depending on
    // the viewer's size, and the grid must not flip between the two.
    while (finest * 2 <= perScreenPixel * (1 + 1e-9) && finest < downsample) finest *= 2;
    const dab = this.discRegion(point.x, point.y);
    const imageWidth = size?.width ?? Infinity;
    const imageHeight = size?.height ?? Infinity;
    const hasBox = box.width > 0 && box.height > 0;
    const left = Math.max(0, Math.min(hasBox ? box.x : Infinity, dab.x));
    const top = Math.max(0, Math.min(hasBox ? box.y : Infinity, dab.y));
    const right = Math.min(
      imageWidth,
      Math.max(hasBox ? box.x + box.width : -Infinity, dab.x + dab.width),
    );
    const bottom = Math.min(
      imageHeight,
      Math.max(hasBox ? box.y + box.height : -Infinity, dab.y + dab.height),
    );
    if (right <= left || bottom <= top) return downsample;
    const limit = maxDownsample > 1 ? this.capacity() : this.capacity() / 4;
    for (let d = finest; d < downsample; d *= 2) {
      const wide = Math.ceil(right / d) - Math.floor(left / d);
      const tall = Math.ceil(bottom / d) - Math.floor(top / d);
      // And no side longer than a canvas draws: a wide coarse mask re-gridded
      // finer was refused at every close zoom (#243 P2).
      if (wide * tall <= limit && wide <= MAX_MASK_CANVAS_SIDE && tall <= MAX_MASK_CANVAS_SIDE) {
        return d;
      }
    }
    return downsample;
  }

  /**
   * Halves the stroke's buffer after it outgrew its cap, if the stroke may
   * coarsen that far, and returns whether it did. The preview is dropped, to
   * be redrawn whole on the coarser grid, and the stroke is marked changed:
   * a coarsened mask is a different mask even where no cell was painted.
   *
   * Never throws. A strategy that throws, a result at the wrong downsample,
   * on another image or outside the source's box rounded out to the coarse
   * grid, or one the buffer refuses (still over the cap, say), leaves the
   * buffer as it was and is kept in `coarsenFailure`, for the refusal to
   * carry as its `cause`: escaping, it reached Fabric on every move and left
   * the stroke half-committed (#243 minor 1). The rest of the strategy
   * contract is `verifyCoarsenStrategy`'s to check. Only reaching the limit
   * is a plain decline.
   */
  private coarsenBuffer(): boolean {
    this.coarsenFailure = undefined;
    try {
      return this.tryCoarsenBuffer();
    } catch (error) {
      this.coarsenFailure = error;
      return false;
    }
  }

  private tryCoarsenBuffer(): boolean {
    const buffer = this.buffer;
    if (!buffer) return false;
    const d = buffer.downsample;
    // As far as the context allows, or back to the grid the stroke started
    // from: a stroke that re-gridded finer may always return there, losslessly
    // (rule 3 of the strategy contract), so re-gridding never turns a stroke
    // that fits at the mask's own grid into a refusal (#243 P1).
    const limit = Math.max(this.strokeMaxDownsample, this.startDownsample);
    if (d * 2 > limit || d * 2 > MAX_MASK_DOWNSAMPLE) return false;
    const strategy = this.config.getCoarsenStrategy?.() ?? majorityCoarsen;
    const source = buffer.raster();
    const coarse = strategy(source);
    if (coarse.downsample !== d * 2) {
      throw new RangeError(
        `A coarsen strategy returned downsample ${coarse.downsample} for ${d}, not ${d * 2}`,
      );
    }
    // The two cheap parts of the contract (#243 minor 2): the same image, and
    // no cell outside the source's box rounded out to the coarse grid. A
    // result relabelled to another image, or placed elsewhere, was committed.
    if (coarse.imageWidth !== source.imageWidth || coarse.imageHeight !== source.imageHeight) {
      throw new RangeError(
        `A coarsen strategy returned a mask of a ${coarse.imageWidth} x ${coarse.imageHeight} ` +
          `image for one of ${source.imageWidth} x ${source.imageHeight}`,
      );
    }
    const s = source.cells;
    const c = coarse.cells;
    if (
      c.width > 0 &&
      c.height > 0 &&
      (s.width === 0 ||
        s.height === 0 ||
        c.x < Math.floor(s.x / 2) ||
        c.y < Math.floor(s.y / 2) ||
        c.x + c.width > Math.ceil((s.x + s.width) / 2) ||
        c.y + c.height > Math.ceil((s.y + s.height) / 2))
    ) {
      throw new RangeError(
        `A coarsen strategy returned a box, ${JSON.stringify(c)}, outside the source's ` +
          `box rounded out to its grid`,
      );
    }
    this.buffer = BoundedDenseMaskBuffer.fromSnapshot(coarse, this.maxPixelsOption());
    this.changesAtStart = undefined;
    const painted = this.paintedBounds;
    if (painted) {
      const x = Math.floor(painted.x / 2);
      const y = Math.floor(painted.y / 2);
      this.paintedBounds = {
        x,
        y,
        width: Math.ceil((painted.x + painted.width) / 2) - x,
        height: Math.ceil((painted.y + painted.height) / 2) - y,
      };
    }
    this.previewBounds = null;
    this.previewPixels = null;
    return true;
  }

  /**
   * Runs a rasterization step, then mirrors the touched pixels onto the preview.
   *
   * `touched` is the image-space box the step could have changed. Passing it in
   * is what keeps a pointer move proportional to the brush rather than to the
   * whole mask.
   */
  private paint(apply: () => void, touched: MaskRegion, from: Point, to: Point): void {
    if (!this.buffer) return;
    // A step that would outgrow the cap writes nothing — the buffer grows
    // before any cell is set — so after coarsening it is painted again whole.
    for (;;) {
      try {
        apply();
        break;
      } catch (error) {
        if (!(error instanceof MaskCapacityExceededError)) throw error;
        if (!this.coarsenBuffer()) {
          this.config.onCapacityExceeded?.(this.refusal(error));
          this.endStroke();
          return;
        }
        this.lastOverflow = error;
      }
    }
    if (!this.buffer) return;
    // Only painting can set a cell, and only the dabs' own cells: growing by
    // the swept slack box, or while erasing, refused near-limit strokes for
    // cells that were never set. Measured on the buffer's grid now, after any
    // coarsening.
    if (!this.erasing) this.growPaintedBounds(this.footprint(from, to));
    for (;;) {
      try {
        this.syncPreview(this.cellsOf(touched));
        return;
      } catch (error) {
        // A stroke that re-gridded finer may find its preview longer than a
        // canvas draws, where the mask's own grid was not: coarsen back
        // toward it, as on an overflow, and draw again (#243 P2).
        if (
          error instanceof MaskCanvasTooLargeError &&
          this.buffer.downsample < this.startDownsample &&
          this.coarsenBuffer()
        ) {
          continue;
        }
        this.refusePreview(error);
        return;
      }
    }
  }

  /** `touched`, in image pixels, as the cells it covers on the buffer's grid. */
  private cellsOf(touched: MaskRegion): MaskRegion {
    const d = this.buffer?.downsample ?? 1;
    const left = Math.floor(touched.x / d);
    const top = Math.floor(touched.y / d);
    return {
      x: left,
      y: top,
      width: Math.ceil((touched.x + touched.width) / d) - left,
      height: Math.ceil((touched.y + touched.height) / d) - top,
    };
  }

  /** Reports a preview the engine or the canvas limit refused, and ends the stroke. */
  private refusePreview(error: unknown): void {
    if (!this.buffer) return;
    // The pixel cap bounds the one-byte buffer, but the preview is a
    // four-byte RGBA raster over up to 2x the buffer's box in each axis,
    // and an engine refuses a canvas or `ImageData` past its own limit (iOS
    // Safari at about 16 megapixels of area) with a plain `RangeError`.
    // That is a capacity failure in every way that matters to the host:
    // report it as one and abandon the stroke with the mask unchanged.
    const bounds = this.previewBounds ?? this.buffer.cellBounds;
    // A re-gridded stroke whose coarsening back failed: say so, and carry
    // the failure, rather than advising a narrower region (#243 minor 1).
    const cause = this.coarsenFailure;
    this.coarsenFailure = undefined;
    this.config.onCapacityExceeded?.(
      error instanceof MaskCanvasTooLargeError && cause !== undefined
        ? new MaskCanvasTooLargeError(error.width, error.height, error.maxPixels, {
            cause,
            causeText: describeThrown(cause),
          })
        : error instanceof MaskCapacityExceededError || error instanceof MaskCanvasTooLargeError
          ? error
          : new MaskCapacityExceededError(
              bounds.width * bounds.height,
              this.maxPixelsOption().maxPixels ?? DEFAULT_MAX_MASK_PIXELS,
              this.buffer.downsample,
            ),
    );
    this.endStroke();
  }

  /**
   * The error a stroke refused at its cap reports: the buffer's own, or — in a
   * context that coarsens — one saying the coarsest allowed grid was reached.
   * A coarsening that failed rather than declined is its `cause`.
   */
  private refusal(error: MaskCapacityExceededError): MaskCapacityExceededError {
    const cause = this.coarsenFailure;
    this.coarsenFailure = undefined;
    if (this.strokeMaxDownsample <= 1 && cause === undefined) return error;
    const advice =
      cause !== undefined
        ? `Coarsening it failed: ${describeThrown(cause)}. ` +
          MaskCapacityExceededError.DEFAULT_ADVICE
        : `It is already at the coarsest downsample this context allows (maxDownsample ` +
          `${this.strokeMaxDownsample}). ${MaskCapacityExceededError.DEFAULT_ADVICE}`;
    return new MaskCapacityExceededError(
      error.requestedCells,
      error.maxCells,
      error.downsample,
      advice,
      cause !== undefined ? { cause } : undefined,
    );
  }

  /**
   * The cells a dab at `from`, swept to `to`, can set, in cells: the
   * rasterizer's own rule, a cell whose centre is within the radius (one cell
   * for a radius under √½). Every stamp of a segment lies between its ends,
   * so the two ends' footprints bound it.
   */
  private footprint(from: Point, to: Point): MaskRegion {
    const d = this.buffer?.downsample ?? 1;
    const radius = this.radius() / d;
    const minX = Math.min(from.x, to.x) / d;
    const maxX = Math.max(from.x, to.x) / d;
    const minY = Math.min(from.y, to.y) / d;
    const maxY = Math.max(from.y, to.y) / d;
    const left = Math.min(Math.floor(minX), Math.ceil(minX - radius - 0.5));
    const top = Math.min(Math.floor(minY), Math.ceil(minY - radius - 0.5));
    const right = Math.max(Math.floor(maxX), Math.floor(maxX + radius - 0.5)) + 1;
    const bottom = Math.max(Math.floor(maxY), Math.floor(maxY + radius - 0.5)) + 1;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** Grows {@link paintedBounds} by a touched region, clipped to the buffer's grid. */
  private growPaintedBounds(touched: MaskRegion): void {
    if (!this.buffer) return;
    const left = Math.max(0, touched.x);
    const top = Math.max(0, touched.y);
    const right = Math.min(this.buffer.gridWidth, touched.x + touched.width);
    const bottom = Math.min(this.buffer.gridHeight, touched.y + touched.height);
    if (right <= left || bottom <= top) return;
    const current = this.paintedBounds;
    if (!current) {
      this.paintedBounds = { x: left, y: top, width: right - left, height: bottom - top };
      return;
    }
    const x = Math.min(current.x, left);
    const y = Math.min(current.y, top);
    this.paintedBounds = {
      x,
      y,
      width: Math.max(current.x + current.width, right) - x,
      height: Math.max(current.y + current.height, bottom) - y,
    };
  }

  private syncPreview(touched: MaskRegion): void {
    if (!this.overlay || !this.buffer) return;
    if (this.hiddenTargetId !== null) this.hideCommittedTarget(this.hiddenTargetId);
    // The buffer's allocation is rounded out to its growth chunks, up to 126
    // cells past the mask; past the canvas limit, size the preview from what
    // can be painted instead, so only a mask that is itself too long is refused.
    const allocated = this.buffer.cellBounds;
    const bounds =
      (allocated.width > MAX_MASK_CANVAS_SIDE || allocated.height > MAX_MASK_CANVAS_SIDE) &&
      this.paintedBounds
        ? this.paintedBounds
        : allocated;
    if (bounds.width === 0 || bounds.height === 0) return;

    // The preview may be *larger* than the buffer's allocated region — the
    // surplus is transparent — so it only has to be rebuilt when the buffer
    // grows past it, not every time the buffer grows at all.
    const current = this.previewBounds;
    const resized =
      !current ||
      bounds.x < current.x ||
      bounds.y < current.y ||
      bounds.x + bounds.width > current.x + current.width ||
      bounds.y + bounds.height > current.y + current.height;

    // A growth carries the pixels it already had into the larger canvas, so
    // only `touched` is ever re-read from the buffer.
    //
    // Repainting the whole allocated region on every growth looked cheap
    // because growths are chunked — but a stroke that travels crosses a chunk
    // boundary constantly, and the region being repainted is growing, so the
    // cost went as roughly the cube of the distance covered. One corner-to-
    // corner drag on an 8192x8192 image blocked the main thread for 15 seconds
    // and built a 256 MB `ImageData`, which is precisely the deep-zoom case
    // this buffer exists to make affordable.
    // A rebuild that could not carry the previous pixels forward starts blank,
    // so the whole region has to be read back from the buffer. That is the
    // first rebuild of every stroke — and when the stroke is refining an
    // existing mask, the buffer already holds all of it.
    let repaint = touched;
    if (resized) {
      const carried = this.rebuildPreview(this.nextPreviewBounds(bounds));
      if (!carried) repaint = this.previewBounds ?? bounds;
    }
    this.repaintPreview(repaint);
    this.overlay.canvas.requestRenderAll();
  }

  /** The image-space box a disc of `radius` at (`cx`, `cy`) can touch. */
  private discRegion(cx: number, cy: number): MaskRegion {
    return this.sweptRegion(cx, cy, cx, cy);
  }

  /** The image-space box a brush swept between two points can touch. */
  private sweptRegion(x0: number, y0: number, x1: number, y1: number): MaskRegion {
    // One pixel of slack either side absorbs the rounding in the rasterizer.
    const radius = this.radius() + 1;
    const left = Math.floor(Math.min(x0, x1) - radius);
    const top = Math.floor(Math.min(y0, y1) - radius);
    return {
      x: left,
      y: top,
      width: Math.ceil(Math.max(x0, x1) + radius) - left + 1,
      height: Math.ceil(Math.max(y0, y1) + radius) - top + 1,
    };
  }

  /**
   * Chooses a preview region that covers `bounds` with room to spare.
   *
   * Sizing it exactly to the buffer meant reallocating on every chunk the
   * buffer grew by, each time larger than the last — cost went as roughly the
   * cube of the distance a stroke covered. Growing by half the current extent
   * in each direction makes the reallocations geometric, so a stroke across a
   * whole image pays for a handful rather than fifty.
   */
  private nextPreviewBounds(bounds: MaskRegion): MaskRegion {
    // Clamped to the *buffer's* image size, not `getImageSize()`.
    //
    // Those are two different numbers. The buffer's is fixed when the stroke
    // starts — from the live size for a new mask, but from the snapshot's own
    // `imageWidth`/`imageHeight` when refining one — while `getImageSize()`
    // reads the viewer every time. A mask recorded against a different image
    // (an import, a COCO round trip, a different pyramid level) makes them
    // disagree with no timing involved at all.
    //
    // When the live size was the smaller of the two, `right` could land left of
    // `left` and the region came out with a negative width: the canvas
    // allocation went haywire, every later repaint early-returned on the
    // inverted clip, and — since the committed object is hidden while painting
    // — the mask simply disappeared for the rest of the stroke. A less extreme
    // mismatch produced a valid rectangle that merely failed to contain the
    // buffer, silently clipping painted pixels out of view.
    //
    // The buffer's size is the right one because it is the space the buffer
    // actually writes in: clamping to it makes the preview and the pixels it
    // displays agree by construction.
    // In cells, like `bounds`: the buffer's grid is the space it writes in.
    const imageWidth = this.buffer?.gridWidth ?? bounds.x + bounds.width;
    const imageHeight = this.buffer?.gridHeight ?? bounds.y + bounds.height;
    return growPreviewBounds(bounds, imageWidth, imageHeight);
  }

  /** Returns whether the previous preview's pixels were carried into the new one. */
  private rebuildPreview(bounds: MaskRegion): boolean {
    if (!this.overlay) return false;
    // The committed mask would be refused by the renderer at this size, and
    // an engine draws such a canvas blank rather than failing, so the stroke
    // would paint nothing visible. Refuse it as a capacity failure instead.
    if (bounds.width > MAX_MASK_CANVAS_SIDE || bounds.height > MAX_MASK_CANVAS_SIDE) {
      throw new MaskCanvasTooLargeError(bounds.width, bounds.height);
    }
    if (this.preview) this.overlay.canvas.remove(this.preview);

    const canvas = document.createElement('canvas');
    canvas.width = bounds.width;
    canvas.height = bounds.height;

    // Via the context rather than the `ImageData` constructor: the constructor
    // is not a jsdom global, and this is the only thing that kept the tool from
    // being unit-testable outside a browser.
    const context = canvas.getContext('2d');
    const pixels = context?.createImageData(bounds.width, bounds.height) ?? null;

    // Carry what the old preview already held into its place in the new one.
    // `grow()` does exactly this for the pixel buffer; without it the enlarged
    // canvas starts blank and the only way to fill it is to re-read every
    // pixel of the mask, which is the cost this avoids.
    // Only when the new region actually contains the old one. It normally does
    // — growth is monotone while the image size holds still — but the image can
    // change under a stroke (a cell swapping its image, `getImageSize()`
    // returning null), and then the carry would read past the end of the new
    // buffer and throw out of a pointer handler.
    const previous = this.previewPixels;
    const previousBounds = this.previewBounds;
    const carryable =
      pixels !== null &&
      previous !== null &&
      previousBounds !== null &&
      previousBounds.width > 0 &&
      previousBounds.x >= bounds.x &&
      previousBounds.y >= bounds.y &&
      previousBounds.x + previousBounds.width <= bounds.x + bounds.width &&
      previousBounds.y + previousBounds.height <= bounds.y + bounds.height;

    if (carryable) {
      const dx = previousBounds.x - bounds.x;
      const dy = previousBounds.y - bounds.y;
      const rowBytes = previousBounds.width * 4;
      for (let row = 0; row < previousBounds.height; row++) {
        const from = row * rowBytes;
        pixels.data.set(
          previous.data.subarray(from, from + rowBytes),
          ((row + dy) * bounds.width + dx) * 4,
        );
      }
      // The canvas itself is new, so the carried pixels have to be drawn once.
      if (context) context.putImageData(pixels, 0, 0);
    }

    this.previewCanvas = canvas;
    this.previewBounds = bounds;
    this.previewPixels = pixels;
    // One preview pixel per cell, scaled to the image pixels it covers — the
    // same placement `buildMaskFabricObject` gives the committed mask, so the
    // stroke does not shift when it is committed.
    const downsample = this.buffer?.downsample ?? 1;
    this.preview = new FabricImage(canvas, {
      left: bounds.x * downsample,
      top: bounds.y * downsample,
      scaleX: downsample,
      scaleY: downsample,
      originX: 'left',
      originY: 'top',
      selectable: false,
      evented: false,
      // No `id`: this is a transient preview, not an annotation object.
      _readOnly: true,
      imageSmoothing: false,
      objectCaching: false,
    });
    this.overlay.canvas.add(this.preview);
    return carryable;
  }

  /**
   * Redraws `touched` (clipped to the preview) from the buffer.
   *
   * Both directions are written, not just the painted ones: an erase has to
   * clear pixels that were opaque a frame ago, so a pixel the buffer no longer
   * holds is zeroed rather than skipped.
   */
  private repaintPreview(touched: MaskRegion): void {
    const canvas = this.previewCanvas;
    const bounds = this.previewBounds;
    const image = this.previewPixels;
    if (!canvas || !bounds || !image || !this.buffer) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const fromCol = Math.max(0, Math.floor(touched.x) - bounds.x);
    const fromRow = Math.max(0, Math.floor(touched.y) - bounds.y);
    const toCol = Math.min(bounds.width, Math.ceil(touched.x + touched.width) - bounds.x);
    const toRow = Math.min(bounds.height, Math.ceil(touched.y + touched.height) - bounds.y);
    if (toCol <= fromCol || toRow <= fromRow) return;

    const [red, green, blue, alphaByte] = this.strokeRgba();
    // A 32-bit word per pixel, written branch-free from a row of cells: a set
    // cell is the tint, a clear one transparent (#238).
    const words = new Uint32Array(image.data.buffer);
    const tint = packRgba(red, green, blue, alphaByte);
    const width = toCol - fromCol;
    const cells = new Uint8Array(width);
    const buffer = this.buffer;
    for (let row = fromRow; row < toRow; row++) {
      const cy = bounds.y + row;
      if (buffer.copyRow) buffer.copyRow(cy, bounds.x + fromCol, bounds.x + toCol, cells);
      else for (let i = 0; i < width; i++) cells[i] = buffer.get(bounds.x + fromCol + i, cy);
      const offset = row * bounds.width + fromCol;
      for (let i = 0; i < width; i++) words[offset + i] = cells[i]! * tint;
    }

    context.putImageData(image, 0, 0, fromCol, fromRow, toCol - fromCol, toRow - fromRow);
    if (this.preview) this.preview.dirty = true;
  }

  /** The stroke tint as bytes, parsed once and reused for the rest of the stroke. */
  /** The colour the stroke's preview paints in. */
  private strokeFill(): string {
    return this.config.getFill?.() ?? this.targetFill ?? DEFAULT_MASK_FILL;
  }

  private strokeRgba(): readonly [number, number, number, number] {
    if (this.previewRgba) return this.previewRgba;
    const fill = this.strokeFill();
    const [red, green, blue, alpha] = new Color(fill).getSource();
    this.previewRgba = [red, green, blue, Math.round((alpha ?? 1) * 255)];
    this.previewFill = fill;
    return this.previewRgba;
  }

  /**
   * Hides the committed object so only the live preview renders during a
   * stroke. If it is not on the canvas yet — the press that started this
   * stroke committed the previous one, and the rebuild has cleared the canvas
   * and not yet re-added — remembers to try again from `syncPreview`.
   */
  private hideCommittedTarget(targetId: AnnotationId): void {
    if (!this.overlay) return;
    const committed = this.overlay.canvas.getObjects().find((obj) => obj.id === targetId);
    if (!committed) {
      this.hiddenTargetId = targetId;
      return;
    }
    this.hiddenTargetId = null;
    this.hiddenTarget = committed;
    committed.set({ visible: false, dirty: true });
  }

  /**
   * Restores the committed object.
   *
   * On a successful stroke the state rebuild replaces it moments later, but on a
   * cancelled or failed stroke nothing else would ever bring it back.
   */
  private restoreCommittedTarget(): void {
    if (!this.hiddenTarget) return;
    this.hiddenTarget.set({ visible: true, dirty: true });
    this.hiddenTarget = null;
  }

  private endStroke(): void {
    this.strokePointerId = null;
    this.hiddenTargetId = null;
    this.restoreCommittedTarget();
    this.painting = false;
    this.lastPoint = null;
    this.buffer = null;
    this.paintedBounds = null;
    this.changesAtStart = undefined;
    this.startDownsample = 1;
    this.coarsenFailure = undefined;
    this.lastOverflow = null;
    this.targetHadCells = false;
    this.strokeMaxDownsample = 1;
    this.targetId = null;
    this.contextId = null;
    if (this.overlay && this.preview) this.overlay.canvas.remove(this.preview);
    this.preview = null;
    this.previewCanvas = null;
    this.previewBounds = null;
    this.previewPixels = null;
    this.previewRgba = null;
    this.previewFill = null;
    this.targetFill = undefined;
    this.overlay?.canvas.requestRenderAll();
  }

  // ── Cursor ───────────────────────────────────────────────────────────────

  private ensureCursor(): void {
    if (!this.overlay || this.cursor) return;
    this.cursor = new Circle({
      // A placeholder: the ring is invisible until the first pointer move,
      // and `updateCursor` sets the real radius alongside the position. Not
      // reading the radius here keeps `activate()` free of config reads, so a
      // reactive host cannot accidentally make the tool's lifetime depend on
      // the brush size.
      radius: 1,
      ...CURSOR_STYLE,
      originX: 'center',
      originY: 'center',
      visible: false,
    });
    this.overlay.canvas.add(this.cursor);
  }

  private updateCursor(imagePoint: Point): void {
    if (!this.cursor || !this.overlay) return;
    this.cursorPoint = imagePoint;
    // Solid when the next stroke refines a mask, dashed when it creates one.
    // During a stroke, the stroke's own buffer says which grid it paints on.
    const peek = this.config.peekTarget?.();
    const creating = peek === null;
    // Between strokes, the grid the next press would paint on: the mask's own,
    // or a finer one it would be re-gridded to there — chosen as the press
    // chooses it, so the cue never shows a grid the stroke does not use.
    let downsample = this.buffer?.downsample;
    if (downsample === undefined) {
      if (!peek) downsample = 1;
      else if (!peek.box) downsample = peek.downsample;
      else {
        downsample = this.strokeDownsample(
          peek.downsample,
          peek.box,
          imagePoint,
          this.maxDownsample(),
        );
      }
    }
    // In screen pixels, as the drawing tools' previews are: the objects live
    // in image space, and `strokeUniform` cancels their own scale but not the
    // viewport's zoom, so at a whole-slide zoom of 0.1 a 1-pixel ring and its
    // dashes shrank to a tenth and solid could not be told from dashed.
    const zoom = this.overlay.canvas.getZoom();
    this.cursorZoom = zoom;
    const perScreenPixel = Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;
    const strokeWidth = CURSOR_STROKE_SCREEN_PX * perScreenPixel;
    const dash = creating ? CURSOR_DASH_SCREEN_PX.map((length) => length * perScreenPixel) : null;
    const cells = downsample > 1 ? this.dabOutline(imagePoint, downsample) : null;

    if (this.cursorCells) {
      this.overlay.canvas.remove(this.cursorCells);
      this.cursorCells = null;
    }
    if (cells) {
      this.cursor.set({ visible: false, dirty: true });
      this.cursorCells = new Path(cells, {
        ...CURSOR_STYLE,
        strokeWidth,
        strokeDashArray: dash,
      });
      this.overlay.canvas.add(this.cursorCells);
      this.overlay.canvas.bringObjectToFront(this.cursorCells);
      return;
    }
    this.cursor.set({
      left: imagePoint.x,
      top: imagePoint.y,
      radius: this.radius(),
      strokeWidth,
      strokeDashArray: dash,
      visible: true,
      dirty: true,
    });
    // Every rebuild appends the annotation objects above the ring, and each
    // stroke's preview is added above it too; a ring under an opaque mask is
    // invisible exactly where the user is painting.
    this.overlay.canvas.bringObjectToFront(this.cursor);
  }

  /**
   * The outline of the cells a dab at `point` would set on a `downsample`
   * grid, as path data in image pixels, or `null` when it sets none (off the
   * image). Computed with the rasterizer itself, so the outline is exactly
   * the footprint and never an approximation of it.
   */
  private dabOutline(point: Point, downsample: number): string | null {
    const size = this.config.getImageSize();
    if (!size) return null;
    const probe = new BoundedDenseMaskBuffer({
      imageWidth: size.width,
      imageHeight: size.height,
      downsample,
    });
    stampCircle(probe, point.x, point.y, this.radius(), 1);
    const { cells, data, imageWidth, imageHeight } = probe.snapshot();
    if (cells.width === 0 || cells.height === 0) return null;
    const at = (cx: number, cy: number): boolean =>
      cx >= cells.x &&
      cy >= cells.y &&
      cx < cells.x + cells.width &&
      cy < cells.y + cells.height &&
      data[(cy - cells.y) * cells.width + (cx - cells.x)] === 1;
    const x = (cx: number) => Math.min(cx * downsample, imageWidth);
    const y = (cy: number) => Math.min(cy * downsample, imageHeight);
    // One segment per cell edge with an unset cell beyond it.
    const segments: string[] = [];
    for (let cy = cells.y; cy < cells.y + cells.height; cy++) {
      for (let cx = cells.x; cx < cells.x + cells.width; cx++) {
        if (!at(cx, cy)) continue;
        if (!at(cx, cy - 1)) segments.push(`M ${x(cx)} ${y(cy)} L ${x(cx + 1)} ${y(cy)}`);
        if (!at(cx, cy + 1)) segments.push(`M ${x(cx)} ${y(cy + 1)} L ${x(cx + 1)} ${y(cy + 1)}`);
        if (!at(cx - 1, cy)) segments.push(`M ${x(cx)} ${y(cy)} L ${x(cx)} ${y(cy + 1)}`);
        if (!at(cx + 1, cy)) segments.push(`M ${x(cx + 1)} ${y(cy)} L ${x(cx + 1)} ${y(cy + 1)}`);
      }
    }
    return segments.join(' ');
  }

  private hideCursor(): void {
    if (!this.cursor) return;
    this.cursor.set({ visible: false, dirty: true });
    if (this.cursorCells && this.overlay) this.overlay.canvas.remove(this.cursorCells);
    this.cursorCells = null;
    this.cursorPoint = null;
    this.overlay?.canvas.requestRenderAll();
  }

  /**
   * Redraws the cue in place after something it shows changed without a
   * pointer move: the radius (`]` / `[`), or whether the next stroke refines
   * or creates (New mask, cancel).
   */
  private refreshCursor(): void {
    if (!this.cursorPoint) return;
    this.updateCursor(this.cursorPoint);
    this.overlay?.canvas.requestRenderAll();
  }

  private removeCursor(): void {
    if (this.overlay && this.cursor) this.overlay.canvas.remove(this.cursor);
    if (this.overlay && this.cursorCells) this.overlay.canvas.remove(this.cursorCells);
    this.cursor = null;
    this.cursorCells = null;
    this.cursorPoint = null;
  }
}
