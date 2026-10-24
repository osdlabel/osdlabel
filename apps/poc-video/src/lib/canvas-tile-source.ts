import OpenSeadragon from 'openseadragon';

/**
 * A one-tile OpenSeadragon TileSource whose only tile *is* `canvas` (or,
 * with `direct`, whatever frame `direct()` returns). Redraw
 * the canvas (a video frame) and call `viewer.forceRedraw()`: the canvas
 * drawer `drawImage`s the tile's context every frame, so the new pixels show
 * on the next OSD draw with no re-fetch and no new cache entry.
 *
 * The WebGL drawer is different: it uploads a tile's canvas to a texture
 * once, on `tile-ready`, and never again. {@link uploadToWebglTile} re-uploads
 * through the drawer's private texture map; OSD 5 has no public API for it.
 */
export function createCanvasTileSource(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  direct?: () => (CanvasImageSource & { width: number; height: number }) | null,
): OpenSeadragon.TileSource {
  const level = Math.ceil(Math.log2(Math.max(width, height)));
  const ts = new OpenSeadragon.TileSource({
    width,
    height,
    tileSize: 2 ** level,
    tileOverlap: 0,
    minLevel: level,
    maxLevel: level,
  });
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d context unavailable');
  Object.assign(ts, {
    getTileUrl: (): string => 'canvas-tile',
    downloadTileStart: (job: OpenSeadragon.ImageJob): void => {
      job.finish(canvas, new XMLHttpRequest(), '');
    },
    downloadTileAbort: (): void => {},
    createTileCache: (cache: { _data?: HTMLCanvasElement }, data: HTMLCanvasElement): void => {
      cache._data = data;
    },
    destroyTileCache: (cache: { _data?: HTMLCanvasElement | undefined }): void => {
      cache._data = undefined;
    },
    getTileCacheData: (): HTMLCanvasElement => canvas,
    getTileCacheDataAsImage: (): HTMLCanvasElement => canvas,
    // With `direct`, the canvas drawer gets a stand-in context whose `canvas`
    // is the current frame: OSD's _drawTileToCanvas only reads `.canvas` (and
    // its width/height) and drawImage()s it, so the frame is drawn once,
    // straight into OSD's canvas, instead of copied into `canvas` first.
    getTileCacheDataAsContext2D: (): CanvasRenderingContext2D => {
      const d = direct?.();
      return d === undefined || d === null
        ? ctx
        : ({ canvas: d } as unknown as CanvasRenderingContext2D);
    },
  });
  return ts;
}

interface WebglDrawerInternals {
  readonly _gl?: WebGLRenderingContext | WebGL2RenderingContext;
  readonly _TextureMap?: Map<HTMLCanvasElement, { readonly texture: WebGLTexture }>;
}

/**
 * Upload `source` into the texture OSD's WebGL drawer made for the tile
 * backed by `tileCanvas`. Returns false when the drawer has no texture for it
 * yet (before the first draw) or is not the WebGL drawer.
 */
export function uploadToWebglTile(
  drawer: unknown,
  tileCanvas: HTMLCanvasElement,
  source: TexImageSource,
): boolean {
  const d = drawer as WebglDrawerInternals;
  const gl = d._gl;
  const info = d._TextureMap?.get(tileCanvas);
  if (gl === undefined || info === undefined) return false;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, info.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  return true;
}
