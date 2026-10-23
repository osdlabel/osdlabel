/**
 * The slice of OpenSeadragon 5.0.1's runtime this package relies on, typed
 * narrowly. `@types/openseadragon` 5.0.2 either omits these members
 * (`DrawerBase.canvas`, `Tile.cacheImageRecord`, `ImageRecord`) or types them
 * as `any` (`TiledImage.getTilesToDraw`), so we read them through guards.
 *
 * Every member listed here is documented in OSD's own JSDoc (none carry
 * `@private`) except `Tile.cacheImageRecord`, which is an undocumented
 * property every built-in drawer reads. Each is a point where an OSD upgrade
 * can break this package; the pixel-pipeline report tracks them.
 */

export interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageRecordLike {
  getData(): unknown;
}

export interface TileLike {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly cacheKey: string;
  readonly positionedBounds: RectLike;
  readonly sourceBounds: RectLike | undefined;
  readonly flipped: boolean | undefined;
  readonly cacheImageRecord: ImageRecordLike | null | undefined;
  getCanvasContext(): CanvasRenderingContext2D | null | undefined;
}

export interface TileToDraw {
  readonly tile: TileLike;
}

export interface TiledImageLike {
  getTilesToDraw(): readonly TileToDraw[];
  getOpacity(): number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isTileLike(v: unknown): v is TileLike {
  return (
    isObject(v) &&
    typeof v['level'] === 'number' &&
    typeof v['cacheKey'] === 'string' &&
    isObject(v['positionedBounds']) &&
    typeof v['getCanvasContext'] === 'function'
  );
}

export function isTiledImageLike(v: unknown): v is TiledImageLike {
  return isObject(v) && typeof v['getTilesToDraw'] === 'function';
}

/** `tile.cacheImageRecord.getData()`, or `undefined` when the tile is not cached. */
export function tileCacheData(tile: TileLike): unknown {
  const record = tile.cacheImageRecord;
  return record ? record.getData() : undefined;
}
