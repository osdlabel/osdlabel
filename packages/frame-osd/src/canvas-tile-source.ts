import OpenSeadragon from 'openseadragon';

/** The parts of OSD's `ImageJob` a synchronous tile source uses (5.0.1). */
interface SyncImageJob {
  readonly src: string;
  finish(data: unknown, request: unknown, errorMessage?: string): void;
}

/** Cache record OSD hands the `*TileCache` hooks. */
interface TileCacheRecord {
  _ctx?: CanvasRenderingContext2D | null;
}

export interface CanvasTileSourceOptions {
  readonly width: number;
  readonly height: number;
  /**
   * Distinguishes this source's tiles in the viewer-wide tile cache, which is
   * keyed by URL. Two sources with the same key would share cached tiles.
   */
  readonly cacheKey: string;
  /** Supplies the tile's pixels. Called synchronously from OSD's image loader. */
  readonly provide: () => CanvasRenderingContext2D;
  /** Whether frames have an alpha channel. Opaque frames skip WebGL's second pass. */
  readonly transparent?: boolean | undefined;
}

/**
 * A single-level, single-tile OpenSeadragon tile source whose one tile is a
 * canvas supplied by the caller, with no network, no `Image` decode and no
 * pyramid.
 *
 * A stack slice or a cine frame is small (512² to ~1k²) and already decoded,
 * so tiling and levels buy nothing and cost a request per tile per level.
 * One level means OSD never shows a blurry lower level first; one tile means
 * one texture upload (WebGL) or one `drawImage` (canvas) per draw.
 *
 * Uses OSD 5.0.1's documented custom-tile-source hooks: `downloadTileStart`
 * finishing synchronously with a 2D context, and the four `*TileCache` hooks
 * storing that context directly.
 */
export function createCanvasTileSource(options: CanvasTileSourceOptions): OpenSeadragon.TileSource {
  const { width, height } = options;
  const level = Math.ceil(Math.log2(Math.max(width, height, 1)));
  const source = new OpenSeadragon.TileSource({
    width,
    height,
    tileSize: Math.max(width, height),
    tileOverlap: 0,
    minLevel: level,
    maxLevel: level,
  });
  const hooks = source as unknown as {
    getTileUrl: (level: number, x: number, y: number) => string;
    downloadTileStart: (job: SyncImageJob) => void;
    downloadTileAbort: (job: SyncImageJob) => void;
    createTileCache: (cache: TileCacheRecord, data: unknown) => void;
    destroyTileCache: (cache: TileCacheRecord) => void;
    getTileCacheData: (cache: TileCacheRecord) => unknown;
    getTileCacheDataAsImage: (cache: TileCacheRecord) => unknown;
    getTileCacheDataAsContext2D: (cache: TileCacheRecord) => CanvasRenderingContext2D | null;
    hasTransparency: () => boolean;
  };
  hooks.getTileUrl = (l, x, y) => `osdlabel-frame://${options.cacheKey}/${l}/${x}_${y}`;
  hooks.downloadTileStart = (job) => {
    job.finish(options.provide(), null);
  };
  hooks.downloadTileAbort = () => {};
  hooks.createTileCache = (cache, data) => {
    cache._ctx = data as CanvasRenderingContext2D;
  };
  hooks.destroyTileCache = (cache) => {
    cache._ctx = null;
  };
  hooks.getTileCacheData = (cache) => cache._ctx ?? null;
  hooks.getTileCacheDataAsImage = (cache) => cache._ctx?.canvas ?? null;
  hooks.getTileCacheDataAsContext2D = (cache) => cache._ctx ?? null;
  // OSD's default reports any context2D tile as transparent, which forces the
  // WebGL drawer's two-pass (render-to-texture) path on every draw.
  hooks.hasTransparency = () => options.transparent ?? false;
  return source;
}

/** A 2D context of the given size, preferring `willReadFrequently: false` (GPU-backed where available). */
export function createFrameCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}
