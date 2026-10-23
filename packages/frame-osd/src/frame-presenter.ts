import type OpenSeadragon from 'openseadragon';
import { clampFrameIndex } from '@osdlabel/frame';
import { createCanvasTileSource, createFrameCanvas } from './canvas-tile-source.js';
import type { FrameSource } from './frame-source.js';

export interface FramePresenterOptions {
  /** Frame shown when the viewer opens. Default 0. */
  readonly initialFrame?: number | undefined;
  /** Cache key for the viewer's tile cache; unique per presenter in a viewer. */
  readonly cacheKey?: string | undefined;
}

/** The minimal event surface used to invalidate the WebGL drawer's texture. */
interface RaisesEvents {
  raiseEvent(name: string, args: object): void;
}

/** OSD 5 drawers expose `getType()`; the 5.0 typings predate it. */
interface TypedDrawer {
  getType?: () => string;
}

let nextKey = 0;

/**
 * Presents the frames of a {@link FrameSource} in ONE OpenSeadragon viewer,
 * with ONE TiledImage and ONE tile whose pixels are swapped in place.
 *
 * `show(i)` paints frame i into the tile's canvas and asks OSD to redraw. It
 * never re-opens the viewer, so the viewport (zoom, pan, rotation, flip), the
 * world's single item and therefore every coordinate conversion the Fabric
 * overlay relies on are untouched by a frame change — the overlay does not
 * even re-sync. The new pixels are on screen at OSD's next animation frame.
 *
 * Drawer specifics (OSD 5.0.1):
 * - canvas drawer: draws from the tile's canvas every draw, so painting into
 *   it is enough.
 * - WebGL drawer: uploads a tile canvas to a texture once and caches the
 *   texture by canvas. OSD has no public "tile content changed" call, so the
 *   presenter raises the drawer's own `image-unloaded` event for the canvas,
 *   which drops the cached texture; the next draw re-uploads it.
 */
export class FramePresenter {
  private readonly _viewer: OpenSeadragon.Viewer;
  private readonly _source: FrameSource;
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _tileSource: OpenSeadragon.TileSource;
  private _frame: number;

  constructor(viewer: OpenSeadragon.Viewer, source: FrameSource, options?: FramePresenterOptions) {
    this._viewer = viewer;
    this._source = source;
    this._ctx = createFrameCanvas(source.width, source.height);
    this._frame = clampFrameIndex(options?.initialFrame ?? 0, source.count);
    source.paint(this._frame, this._ctx);
    this._tileSource = createCanvasTileSource({
      width: source.width,
      height: source.height,
      cacheKey: options?.cacheKey ?? `presenter-${nextKey++}`,
      provide: () => this._ctx,
    });
  }

  /** The tile source to hand to `viewer.open()` (or use {@link open}). */
  get tileSource(): OpenSeadragon.TileSource {
    return this._tileSource;
  }

  /** The canvas holding the current frame (the single tile's pixels). */
  get canvas(): HTMLCanvasElement {
    return this._ctx.canvas;
  }

  /** The frame currently in the tile. */
  get frame(): number {
    return this._frame;
  }

  get count(): number {
    return this._source.count;
  }

  /** Open the presenter's tile source in the viewer. */
  open(): void {
    this._viewer.open(this._tileSource);
  }

  /**
   * Show frame `index` (clamped). Returns `false`, and keeps the current
   * frame on screen, when the source does not have the frame resident yet.
   */
  show(index: number): boolean {
    const i = clampFrameIndex(index, this._source.count);
    if (i === this._frame) return true;
    if (!this._source.paint(i, this._ctx)) return false;
    this._frame = i;
    this.invalidate();
    return true;
  }

  /**
   * Re-present the current tile canvas after its pixels changed by other
   * means (a LUT change, a source that paints asynchronously).
   */
  invalidate(): void {
    if ((this._viewer.drawer as unknown as TypedDrawer | undefined)?.getType?.() === 'webgl') {
      (this._viewer as unknown as RaisesEvents).raiseEvent('image-unloaded', {
        context2D: this._ctx,
      });
    }
    this._viewer.forceRedraw();
  }
}
