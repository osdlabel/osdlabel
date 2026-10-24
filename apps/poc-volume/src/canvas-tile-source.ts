import OpenSeadragon from 'openseadragon';

/**
 * An OpenSeadragon tile source whose single tile IS a canvas we own.
 *
 * A reslice writes pixels into `canvas`; the cell then redraws. This is the
 * only seam between a volume and an osdlabel cell: OSD keeps doing what it
 * does (viewport, pan / zoom / rotate / flip, drawing), the FabricOverlay
 * keeps mapping image space to screen space, and "image space" is simply the
 * reslice plane's pixel grid.
 *
 * Hooks used are OSD 5's documented TileSource extension points
 * (`downloadTileStart` + the `*TileCache` family). What OSD 5 does NOT have is
 * a public way to say "this tile's pixels changed": the canvas drawer reads the
 * canvas on every draw so a redraw suffices, but the WebGL drawer caches a
 * texture per tile canvas, and the only way to refresh it is its private
 * `_cleanupImageData` (see {@link invalidateTile}).
 */
interface TileCache {
  _ctx?: CanvasRenderingContext2D | null;
}

interface ImageJobLike {
  finish(data: unknown, request: unknown, errorMessage?: string): void;
}

interface TileSourceHooks {
  getTileUrl(level: number, x: number, y: number): string;
  downloadTileStart(job: ImageJobLike): void;
  downloadTileAbort(job: ImageJobLike): void;
  createTileCache(cache: TileCache, data: unknown): void;
  destroyTileCache(cache: TileCache): void;
  getTileCacheData(cache: TileCache): unknown;
  getTileCacheDataAsImage(cache: TileCache): HTMLCanvasElement;
  getTileCacheDataAsContext2D(cache: TileCache): CanvasRenderingContext2D;
}

let nextSourceId = 1;

export function createCanvasTileSource(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): OpenSeadragon.TileSource {
  const id = nextSourceId++;
  const size = Math.max(canvas.width, canvas.height);
  const level = Math.ceil(Math.log2(size));
  const source = new OpenSeadragon.TileSource({
    width: canvas.width,
    height: canvas.height,
    tileSize: size,
    tileOverlap: 0,
    minLevel: level,
    maxLevel: level,
  });
  const hooks: TileSourceHooks = {
    getTileUrl: (l, x, y) => `volume-plane://${id}/${l}/${x}/${y}`,
    downloadTileStart: (job) => job.finish(canvas, null),
    downloadTileAbort: () => undefined,
    createTileCache: (cache) => {
      cache._ctx = ctx;
    },
    destroyTileCache: (cache) => {
      cache._ctx = null;
    },
    getTileCacheData: (cache) => cache._ctx,
    getTileCacheDataAsImage: () => canvas,
    getTileCacheDataAsContext2D: () => ctx,
  };
  return Object.assign(source, hooks);
}

interface WebGlDrawerInternals {
  _cleanupImageData?: (canvas: HTMLCanvasElement) => void;
}

/**
 * Tell the viewer's drawer that the plane canvas changed. Canvas drawer:
 * nothing to do. WebGL drawer: drop its cached texture (private API) so the
 * next draw re-uploads. Returns whether a private hook was needed.
 */
export function invalidateTile(viewer: OpenSeadragon.Viewer, canvas: HTMLCanvasElement): boolean {
  const drawer = viewer.drawer as unknown as WebGlDrawerInternals;
  if (typeof drawer._cleanupImageData === 'function') {
    drawer._cleanupImageData(canvas);
    return true;
  }
  return false;
}

interface WorldWithDraw {
  draw(): void;
}

/** Synchronously redraw the viewer's current tiles (OSD's World.draw). */
export function drawNow(viewer: OpenSeadragon.Viewer): void {
  (viewer.world as unknown as WorldWithDraw).draw();
}
