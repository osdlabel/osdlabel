import OpenSeadragon from 'openseadragon';
import type { GrayscaleRaster } from '@osdlabel/pixel';
import { applyVoiLutRgba32, extractRegion } from '@osdlabel/pixel';
import type { VoiState } from './voi-state.js';

/** What `downloadTileStart` hands OSD for one tile: stored values, not pixels. */
export interface RasterTileData {
  readonly kind: 'osdlabel-raster';
  readonly raster: GrayscaleRaster;
}

export function isRasterTileData(v: unknown): v is RasterTileData {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'osdlabel-raster' &&
    typeof (v as { raster?: unknown }).raster === 'object'
  );
}

/**
 * The members of OSD's `ImageJob` a `downloadTileStart` override uses. The
 * typings omit `src` and require a non-null `XMLHttpRequest` in `finish`.
 */
interface RasterJob {
  readonly src: string;
  finish(data: unknown, request: null, errorMessage?: string): void;
}

function asRasterJob(job: unknown): RasterJob {
  if (
    typeof job !== 'object' ||
    job === null ||
    typeof (job as { src?: unknown }).src !== 'string' ||
    typeof (job as { finish?: unknown }).finish !== 'function'
  ) {
    throw new Error('raster tile source: not an OSD ImageJob');
  }
  return job as RasterJob;
}

/** Per-cached-tile state of the CPU VOI path. */
interface CacheEntry {
  readonly data: RasterTileData;
  ctx: CanvasRenderingContext2D | null;
  image: ImageData | null;
  version: number;
}

/** Counters the benchmark reads; reset them between measurements. */
export interface CpuPathStats {
  tilesReprocessed: number;
  pixelsReprocessed: number;
  lutMs: number;
  putImageDataMs: number;
}

export interface RasterTileSourceOptions {
  /** Pyramid, coarsest first: index = OSD level, last = full resolution. */
  readonly levels: readonly GrayscaleRaster[];
  readonly tileSize: number;
  readonly voi: VoiState;
  /** Distinguishes this source's tiles in cache keys. */
  readonly id: string;
}

export interface RasterTileSource {
  /** Pass to `viewer.open()` (it is an `OpenSeadragon.TileSource`). */
  readonly tileSource: OpenSeadragon.TileSource;
  readonly stats: CpuPathStats;
  resetStats(): void;
}

/**
 * A TileSource over an in-memory high-bit-depth pyramid, built only from
 * OSD 5.0.1's documented TileSource overrides:
 *
 * - `getTileUrl` / `downloadTileStart` / `downloadTileAbort` produce a
 *   {@link RasterTileData} instead of an `Image`;
 * - `createTileCache` / `destroyTileCache` / `getTileCacheData` keep it in
 *   OSD's own tile cache (so eviction, `maxImageCacheCount` and the
 *   `tile-unloaded` event all keep working);
 * - `getTileCacheDataAsContext2D` / `getTileCacheDataAsImage` are the CPU VOI
 *   path: they render stored values through the current LUT into an 8-bit
 *   canvas, lazily, and re-render when {@link VoiState.version} moves on.
 *   OSD's `CanvasDrawer` calls them on every frame for every drawn tile, so a
 *   window change costs exactly the visible tiles.
 *
 * Gotcha: OSD invokes the `*TileCache*` overrides unbound (`apply(null, …)`),
 * so they are closures here, never methods relying on `this`.
 */
export function createRasterTileSource(options: RasterTileSourceOptions): RasterTileSource {
  const { levels, tileSize, voi, id } = options;
  const full = levels[levels.length - 1];
  if (!full) throw new Error('createRasterTileSource: empty pyramid');

  const stats: CpuPathStats = {
    tilesReprocessed: 0,
    pixelsReprocessed: 0,
    lutMs: 0,
    putImageDataMs: 0,
  };
  const entries = new WeakMap<object, CacheEntry>();

  const tileSource = new OpenSeadragon.TileSource({
    width: full.width,
    height: full.height,
    tileSize,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: levels.length - 1,
  });

  const prefix = `osdlabel-raster://${id}/`;
  tileSource.getTileUrl = (level: number, x: number, y: number): string =>
    `${prefix}${level}/${x}/${y}`;

  tileSource.hasTransparency = (): boolean => false;

  tileSource.downloadTileStart = (imageJob: OpenSeadragon.ImageJob): void => {
    const job = asRasterJob(imageJob);
    const src = job.src;
    const parts = src.slice(prefix.length).split('/').map(Number);
    const [level, x, y] = parts;
    const raster = level !== undefined ? levels[level] : undefined;
    const finish = (data: unknown, err?: string): void => job.finish(data, null, err);
    if (!raster || x === undefined || y === undefined) {
      queueMicrotask(() => finish(null, `bad raster tile url ${src}`));
      return;
    }
    const data: RasterTileData = {
      kind: 'osdlabel-raster',
      raster: extractRegion(raster, x * tileSize, y * tileSize, tileSize, tileSize),
    };
    queueMicrotask(() => finish(data));
  };
  tileSource.downloadTileAbort = (): void => {};

  tileSource.createTileCache = (cacheObject: object, data: unknown): void => {
    if (!isRasterTileData(data)) throw new Error('raster tile source: unexpected tile data');
    entries.set(cacheObject, { data, ctx: null, image: null, version: -1 });
  };

  tileSource.destroyTileCache = (cacheObject: object): void => {
    const e = entries.get(cacheObject);
    if (e?.ctx) {
      // Same as OSD's own cleanup: release canvas memory eagerly.
      e.ctx.canvas.width = 0;
      e.ctx.canvas.height = 0;
    }
    entries.delete(cacheObject);
  };

  tileSource.getTileCacheData = (cacheObject: object): unknown => entries.get(cacheObject)?.data;

  const render = (cacheObject: object): CanvasRenderingContext2D => {
    const e = entries.get(cacheObject);
    if (!e) throw new Error('raster tile source: tile not cached');
    const { raster } = e.data;
    if (!e.ctx || !e.image) {
      const canvas = document.createElement('canvas');
      canvas.width = raster.width;
      canvas.height = raster.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) throw new Error('raster tile source: no 2d context');
      e.ctx = ctx;
      e.image = new ImageData(raster.width, raster.height);
    }
    if (e.version !== voi.version) {
      const t0 = performance.now();
      applyVoiLutRgba32(raster.data, voi.lut(), new Uint32Array(e.image.data.buffer));
      const t1 = performance.now();
      e.ctx.putImageData(e.image, 0, 0);
      stats.lutMs += t1 - t0;
      stats.putImageDataMs += performance.now() - t1;
      stats.tilesReprocessed++;
      stats.pixelsReprocessed += raster.width * raster.height;
      e.version = voi.version;
    }
    return e.ctx;
  };

  tileSource.getTileCacheDataAsContext2D = (cacheObject: object): CanvasRenderingContext2D =>
    render(cacheObject);
  // HTMLDrawer appends this to the DOM; a canvas serves as well as an <img>.
  tileSource.getTileCacheDataAsImage = (cacheObject: object): HTMLImageElement =>
    render(cacheObject).canvas as unknown as HTMLImageElement;

  return {
    tileSource,
    stats,
    resetStats(): void {
      stats.tilesReprocessed = 0;
      stats.pixelsReprocessed = 0;
      stats.lutMs = 0;
      stats.putImageDataMs = 0;
    },
  };
}
