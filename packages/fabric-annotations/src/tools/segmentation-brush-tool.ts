import { Circle, Color, FabricImage, type FabricObject } from 'fabric';
import { BaseTool, type ToolCallbacks } from './base-tool.js';
import type { AnnotationId, Point, ToolType } from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId, KeyboardShortcutMap } from '@osdlabel/viewer-api';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  stampCircle,
  strokeSegment,
  type MaskBuffer,
  type MaskRegion,
  type MaskSnapshot,
} from '@osdlabel/mask';
import { DEFAULT_MASK_FILL } from '../mask-fabric-object.js';
import type { ToolOverlay } from '../types.js';

/** The painted result of one stroke, handed to the host to persist. */
export interface BrushStrokeCommit {
  /** Existing mask being refined, or `null` when the stroke created a new one. */
  readonly annotationId: AnnotationId | null;
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  readonly snapshot: MaskSnapshot;
}

/** The mask a stroke should paint into, resolved by the host. */
export interface BrushTarget {
  readonly annotationId: AnnotationId;
  readonly snapshot: MaskSnapshot;
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
  /** Called when a stroke would grow the mask past its pixel cap. */
  readonly onCapacityExceeded?: ((error: MaskCapacityExceededError) => void) | undefined;
  readonly maxPixels?: number | undefined;
}

/**
 * Freehand raster brush: paints (or erases) pixels into a mask annotation.
 *
 * Pixels are mutated in a plain buffer and mirrored onto an offscreen canvas
 * during the stroke, so nothing touches reactive state until the pointer is
 * released — one dispatch per stroke rather than one per pointer sample.
 *
 * Erasing is Alt-held (matching CVAT and QuPath) or a host-driven toggle,
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
  /** The refined mask's own tint, so the preview does not recolour it. */
  private targetFill: string | undefined;

  /** Ring showing the brush footprint under the cursor. */
  private cursor: Circle | null = null;

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
  }

  deactivate(): void {
    this.removeCursor();
    super.deactivate();
  }

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

      this.buffer = target
        ? BoundedDenseMaskBuffer.fromSnapshot(target.snapshot, this.maxPixelsOption())
        : new BoundedDenseMaskBuffer({
            imageWidth: imageSize.width,
            imageHeight: imageSize.height,
            ...this.maxPixelsOption(),
          });
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
    );
  }

  onPointerUp(event: PointerEvent, _imagePoint: Point): void {
    if (this.painting && !this.isStrokePointer(event)) return;
    this.finishStroke();
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

    const snapshot = this.buffer.snapshot();
    const commit: BrushStrokeCommit = {
      annotationId: this.targetId,
      imageId: this.imageId,
      contextId: this.contextId,
      snapshot,
    };
    this.endStroke();
    this.config.onCommit(commit);
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
        this.refreshCursorRadius();
        return true;
      }
      if (event.key === this.shortcuts.decreaseBrushRadius) {
        this.config.onAdjustRadius(-1);
        this.refreshCursorRadius();
        return true;
      }
    }
    if (this.painting && this.shortcuts) {
      if (event.key === this.shortcuts.cancel) {
        this.cancel();
        return true;
      }
      // Deleting the mask being refined mid-stroke would leave the stroke
      // with nothing to commit into; the key waits for the release.
      if (event.key === this.shortcuts.delete || event.key === this.shortcuts.deleteAlt) {
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
    const cap = this.config.maxPixels;
    return cap !== undefined && Number.isFinite(cap) && cap > 0 ? { maxPixels: cap } : {};
  }

  /**
   * Runs a rasterization step, then mirrors the touched pixels onto the preview.
   *
   * `touched` is the image-space box the step could have changed. Passing it in
   * is what keeps a pointer move proportional to the brush rather than to the
   * whole mask.
   */
  private paint(apply: () => void, touched: MaskRegion): void {
    if (!this.buffer) return;
    try {
      apply();
    } catch (error) {
      if (error instanceof MaskCapacityExceededError) {
        this.config.onCapacityExceeded?.(error);
        this.endStroke();
        return;
      }
      throw error;
    }
    try {
      this.syncPreview(touched);
    } catch (error) {
      // The pixel cap bounds the one-byte buffer, but the preview is a
      // four-byte RGBA raster over up to 1.5x the buffer's box in each axis,
      // and an engine refuses a canvas or `ImageData` past its own limit (iOS
      // Safari at about 16 megapixels of area) with a plain `RangeError`.
      // That is a capacity failure in every way that matters to the host:
      // report it as one and abandon the stroke with the mask unchanged.
      const bounds = this.previewBounds ?? this.buffer.bounds;
      this.config.onCapacityExceeded?.(
        error instanceof MaskCapacityExceededError
          ? error
          : new MaskCapacityExceededError(
              bounds.width * bounds.height,
              this.config.maxPixels ?? DEFAULT_MAX_MASK_PIXELS,
            ),
      );
      this.endStroke();
    }
  }

  private syncPreview(touched: MaskRegion): void {
    if (!this.overlay || !this.buffer) return;
    if (this.hiddenTargetId !== null) this.hideCommittedTarget(this.hiddenTargetId);
    const bounds = this.buffer.bounds;
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
    const imageWidth = this.buffer?.imageWidth ?? bounds.x + bounds.width;
    const imageHeight = this.buffer?.imageHeight ?? bounds.y + bounds.height;
    const marginX = Math.ceil(bounds.width / 2);
    const marginY = Math.ceil(bounds.height / 2);

    // `min`/`max` against `bounds` on both sides, so containment is structural
    // rather than a property the margins happen to preserve. Whatever the
    // image size says, the preview always covers what the buffer holds.
    const left = Math.min(bounds.x, Math.max(0, bounds.x - marginX));
    const top = Math.min(bounds.y, Math.max(0, bounds.y - marginY));
    const right = Math.max(
      bounds.x + bounds.width,
      Math.min(imageWidth, bounds.x + bounds.width + marginX),
    );
    const bottom = Math.max(
      bounds.y + bounds.height,
      Math.min(imageHeight, bounds.y + bounds.height + marginY),
    );
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** Returns whether the previous preview's pixels were carried into the new one. */
  private rebuildPreview(bounds: MaskRegion): boolean {
    if (!this.overlay) return false;
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
    this.preview = new FabricImage(canvas, {
      left: bounds.x,
      top: bounds.y,
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
    const pixels = image.data;
    for (let row = fromRow; row < toRow; row++) {
      let offset = (row * bounds.width + fromCol) * 4;
      for (let col = fromCol; col < toCol; col++, offset += 4) {
        if (this.buffer.get(bounds.x + col, bounds.y + row) === 1) {
          pixels[offset] = red;
          pixels[offset + 1] = green;
          pixels[offset + 2] = blue;
          pixels[offset + 3] = alphaByte;
        } else {
          pixels[offset + 3] = 0;
        }
      }
    }

    context.putImageData(image, 0, 0, fromCol, fromRow, toCol - fromCol, toRow - fromRow);
    if (this.preview) this.preview.dirty = true;
  }

  /** The stroke tint as bytes, parsed once and reused for the rest of the stroke. */
  private strokeRgba(): readonly [number, number, number, number] {
    if (this.previewRgba) return this.previewRgba;
    const [red, green, blue, alpha] = new Color(
      this.config.getFill?.() ?? this.targetFill ?? DEFAULT_MASK_FILL,
    ).getSource();
    this.previewRgba = [red, green, blue, Math.round((alpha ?? 1) * 255)];
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
    this.targetId = null;
    this.contextId = null;
    if (this.overlay && this.preview) this.overlay.canvas.remove(this.preview);
    this.preview = null;
    this.previewCanvas = null;
    this.previewBounds = null;
    this.previewPixels = null;
    this.previewRgba = null;
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
      fill: 'transparent',
      stroke: 'rgba(255, 255, 255, 0.9)',
      strokeWidth: 1,
      strokeUniform: true,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      _readOnly: true,
      objectCaching: false,
      visible: false,
    });
    this.overlay.canvas.add(this.cursor);
  }

  private updateCursor(imagePoint: Point): void {
    if (!this.cursor || !this.overlay) return;
    this.cursor.set({
      left: imagePoint.x,
      top: imagePoint.y,
      radius: this.radius(),
      visible: true,
      dirty: true,
    });
    // Every rebuild appends the annotation objects above the ring, and each
    // stroke's preview is added above it too; a ring under an opaque mask is
    // invisible exactly where the user is painting.
    this.overlay.canvas.bringObjectToFront(this.cursor);
  }

  private hideCursor(): void {
    if (!this.cursor) return;
    this.cursor.set({ visible: false, dirty: true });
    this.overlay?.canvas.requestRenderAll();
  }

  /** After `]` / `[` without a pointer move, the ring would show the old size. */
  private refreshCursorRadius(): void {
    if (!this.cursor?.visible) return;
    this.cursor.set({ radius: this.radius(), dirty: true });
    this.overlay?.canvas.requestRenderAll();
  }

  private removeCursor(): void {
    if (this.overlay && this.cursor) this.overlay.canvas.remove(this.cursor);
    this.cursor = null;
  }
}
