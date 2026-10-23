import OpenSeadragon from 'openseadragon';
import type { TextureFormat } from './gl-shaders.js';
import type { RendererStats, TileTexture } from './gl-renderer.js';
import type { GlTarget, GlTargetKind } from './gl-targets.js';
import { OwnCanvasTarget, PageCanvasTarget, SharedContextTarget } from './gl-targets.js';
import { multiply, tileMatrix, viewMatrix } from './mat3.js';
import type { TileLike } from './osd-surface.js';
import { isTiledImageLike, isTileLike, tileCacheData } from './osd-surface.js';
import { isRasterTileData } from './raster-tile-source.js';
import type { VoiState } from './voi-state.js';

/**
 * Options for {@link VoiWebGLDrawer}, passed as OSD's
 * `drawerOptions: { custom: { … } }` (OSD hands a class-valued `drawer` the
 * `custom` entry).
 */
export interface VoiDrawerOptions {
  /** Window state for raster tiles. Stock 8-bit tiles ignore it. */
  readonly voi?: VoiState | undefined;
  /** GPU storage for 16-bit tiles (default `r16i`). */
  readonly format?: TextureFormat | undefined;
  /** Context strategy (default `own`). */
  readonly target?: GlTargetKind | undefined;
}

/** Per-drawer counters for the benchmark. */
export interface VoiDrawerStats {
  frames: number;
  /** JS time inside `draw()`, i.e. CPU-side submission (uploads included). */
  drawMs: number;
  tilesDrawn: number;
  skippedFrames: number;
}

interface TextureEntry {
  readonly tex: TileTexture;
  readonly tiles: Set<TileLike>;
}

interface DrawerConstructionOptions {
  readonly viewer: OpenSeadragon.Viewer;
  readonly viewport: OpenSeadragon.Viewport;
  readonly element: HTMLElement;
  readonly options?: VoiDrawerOptions | undefined;
}

/**
 * A WebGL2 drawer for OpenSeadragon 5.0.1 that windows high-bit-depth tiles
 * on the GPU, built only on OSD's public drawer contract: pass the class as
 * the `drawer` option (`requestDrawer` accepts any `DrawerBase` subclass).
 *
 * It implements the five methods `DrawerBase` checks for
 * (`_createDrawingElement`, `draw`, `canRotate`, `destroy`,
 * `setImageSmoothingEnabled`), `getType` and `static isSupported`, and reads
 * tiles through `TiledImage.getTilesToDraw()`. Geometry is OSD's own
 * `WebGLDrawer` matrix, so anything that tracks the OSD viewport (the Fabric
 * overlay) stays registered.
 *
 * Raster tiles (from `createRasterTileSource`) become 16-bit textures whose
 * window is a uniform: a W/L change re-uploads nothing. Any other tile is
 * drawn as the 8-bit canvas OSD caches for it, as `WebGLDrawer` would.
 */
export class VoiWebGLDrawer extends OpenSeadragon.DrawerBase {
  // Set by DrawerBase's constructor. `declare` so no field initialiser
  // overwrites them after super() returns.
  declare readonly viewer: OpenSeadragon.Viewer;
  declare readonly viewport: OpenSeadragon.Viewport;
  declare readonly container: HTMLElement;
  declare readonly canvas: HTMLCanvasElement;
  declare readonly options: VoiDrawerOptions;

  readonly stats: VoiDrawerStats = { frames: 0, drawMs: 0, tilesDrawn: 0, skippedFrames: 0 };
  private readonly _target: GlTarget;
  private readonly _textures = new Map<string, TextureEntry>();
  private _smooth = true;
  private _destroyed = false;
  private readonly _onTileUnloaded = (event: { tile?: unknown }): void => {
    const tile = event.tile;
    if (!isTileLike(tile)) return;
    const entry = this._textures.get(tile.cacheKey);
    if (!entry) return;
    entry.tiles.delete(tile);
    if (entry.tiles.size === 0) {
      this._target.renderer()?.deleteTexture(entry.tex);
      this._textures.delete(tile.cacheKey);
    }
  };

  constructor(options: DrawerConstructionOptions) {
    super(options);
    const kind = this.options.target ?? 'own';
    this._target =
      kind === 'own'
        ? new OwnCanvasTarget(this.canvas)
        : kind === 'shared'
          ? new SharedContextTarget(this.canvas)
          : new PageCanvasTarget(this.container);
    this._target.onReset(() => {
      // Textures died with the context; the raw data is still in OSD's tile
      // cache, so dropping the map is all recovery needs.
      this._textures.clear();
      this.viewer.forceRedraw();
    });
    this.viewer.addHandler('tile-unloaded', this._onTileUnloaded);
  }

  static override isSupported(): boolean {
    // Unlike WebGLDrawer.isSupported, do not create (and leak until GC) a
    // throwaway context just to answer.
    return typeof WebGL2RenderingContext !== 'undefined';
  }

  override getType(): string {
    return 'osdlabel-voi-webgl';
  }

  /** Current context strategy. */
  get targetKind(): GlTargetKind {
    return this._target.kind;
  }

  get targetStats(): GlTarget['stats'] {
    return this._target.stats;
  }

  /** The renderer's counters (uploads, live textures), or null while lost. */
  get rendererStats(): RendererStats | null {
    return this._target.renderer()?.stats ?? null;
  }

  /**
   * fabric-osd's `ToneCapableDrawer` seam: `FabricOverlay.applyImageFilters`
   * hands the cell's relative tone here instead of setting a CSS filter, so
   * the existing exposure/contrast/invert controls window the 16-bit data.
   */
  applyImageFilters(filters: { exposure: number; contrast: number; inverted: boolean }): void {
    this.options.voi?.applyTone(filters);
    this.viewer.forceRedraw();
  }

  /**
   * Block until the GPU has finished the last frame (benchmarks only). A
   * 1-pixel `readPixels` is used rather than `gl.finish()`, which some
   * implementations return from early.
   */
  finish(): void {
    const gl = this._target.renderer()?.gl;
    if (!gl) return;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  // ── DrawerBase contract ──────────────────────────────────────────────

  _createDrawingElement(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    const size = this.viewport.getContainerSize();
    canvas.width = Math.round(size.x * OpenSeadragon.pixelDensityRatio);
    canvas.height = Math.round(size.y * OpenSeadragon.pixelDensityRatio);
    return canvas;
  }

  override canRotate(): boolean {
    return true;
  }

  override setImageSmoothingEnabled(enabled: boolean): void {
    if (this._smooth === enabled) return;
    this._smooth = enabled;
    // Float/RGBA samplers bake the filter in: re-upload lazily.
    const r = this._target.renderer();
    for (const [key, e] of this._textures) {
      if (e.tex.kind === 'float' || e.tex.kind === 'rgba') {
        r?.deleteTexture(e.tex);
        this._textures.delete(key);
      }
    }
    this.viewer.forceRedraw();
  }

  draw(tiledImages: readonly unknown[]): void {
    if (this._destroyed) return;
    const t0 = performance.now();
    const size = this.viewport.getContainerSize();
    const dpr = OpenSeadragon.pixelDensityRatio;
    const w = Math.round(size.x * dpr);
    const h = Math.round(size.y * dpr);
    if (!this._target.begin(w, h)) {
      this.stats.skippedFrames++;
      return;
    }
    const renderer = this._target.renderer();
    if (!renderer) return;
    const bounds = this.viewport.getBoundsNoRotateWithMargins(true);
    const view = viewMatrix(bounds, this.viewport.getRotation(true), this.viewport.getFlip());
    const voi = this.options.voi;
    const format = this.options.format ?? 'r16i';

    for (const item of tiledImages) {
      if (!isTiledImageLike(item)) continue;
      const opacity = item.getOpacity();
      if (opacity === 0) continue;
      for (const { tile } of item.getTilesToDraw()) {
        let entry = this._textures.get(tile.cacheKey);
        if (!entry) {
          const data = tileCacheData(tile);
          let tex: TileTexture | null = null;
          if (isRasterTileData(data)) {
            tex = renderer.uploadRaster(data.raster, format, this._smooth);
          } else {
            const canvas = tile.getCanvasContext()?.canvas;
            if (canvas) tex = renderer.uploadCanvas(canvas, this._smooth);
          }
          if (!tex) continue;
          entry = { tex, tiles: new Set() };
          this._textures.set(tile.cacheKey, entry);
        }
        entry.tiles.add(tile);
        const pb = tile.positionedBounds;
        let m = multiply(view, tileMatrix(pb.x, pb.y, pb.width, pb.height));
        if (tile.flipped) {
          m = multiply(m, [-1, 0, 0, 0, 1, 0, 1, 0, 1]);
        }
        const sb = tile.sourceBounds;
        const sx = sb ? Math.min(sb.width, entry.tex.width) / entry.tex.width : 1;
        const sy = sb ? Math.min(sb.height, entry.tex.height) / entry.tex.height : 1;
        renderer.drawTile(
          entry.tex,
          m,
          [sx, sy],
          voi ? voi.transform : null,
          this._smooth,
          opacity,
        );
        this.stats.tilesDrawn++;
      }
    }
    this._target.end(w, h);
    this.stats.frames++;
    this.stats.drawMs += performance.now() - t0;
  }

  override destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.viewer.removeHandler('tile-unloaded', this._onTileUnloaded);
    const r = this._target.renderer();
    for (const e of this._textures.values()) r?.deleteTexture(e.tex);
    this._textures.clear();
    this._target.release();
    this.canvas.width = this.canvas.height = 1;
    this.canvas.remove();
    // What WebGLDrawer.destroy does, so requestDrawer can replace us.
    const v = this.viewer as unknown as { drawer: unknown };
    if (v.drawer === this) v.drawer = null;
  }
}
