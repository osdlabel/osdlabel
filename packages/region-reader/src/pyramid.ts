/**
 * A serialisable description of where an image's pixels live. Serialisable on
 * purpose: a worker (or a server) can read regions from it without the
 * OpenSeadragon viewer, so model inputs never come from the screen canvas.
 */
export interface DziPyramid {
  readonly kind: 'dzi';
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly overlap: number;
  /** Tile URL with `{level}`, `{x}` and `{y}` placeholders. */
  readonly tileUrlTemplate: string;
}

/** A plain image (OSD's `type: 'image'`): one URL, no levels. */
export interface SingleImagePyramid {
  readonly kind: 'image';
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

export type TilePyramid = DziPyramid | SingleImagePyramid;

/** Highest DZI level, the one at full resolution. */
export function dziMaxLevel(width: number, height: number): number {
  return Math.ceil(Math.log2(Math.max(width, height)));
}

export function dziLevelScale(p: DziPyramid, level: number): number {
  return 2 ** (level - dziMaxLevel(p.width, p.height));
}

export function dziLevelSize(p: DziPyramid, level: number): { width: number; height: number } {
  const s = dziLevelScale(p, level);
  return { width: Math.ceil(p.width * s), height: Math.ceil(p.height * s) };
}

export function dziTileUrl(p: DziPyramid, level: number, x: number, y: number): string {
  return p.tileUrlTemplate
    .replace('{level}', String(level))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * The structural subset of an OpenSeadragon `TileSource` this package reads.
 * Typed locally so the package has no OpenSeadragon dependency.
 */
export interface OsdTileSourceLike {
  readonly width?: number;
  readonly height?: number;
  readonly dimensions?: { readonly x: number; readonly y: number };
  readonly tileOverlap?: number;
  readonly maxLevel?: number;
  getTileWidth?(level: number): number;
  getTileUrl?(level: number, x: number, y: number): string | (() => string);
  /** Present on OSD's `ImageTileSource`. */
  readonly url?: string;
  readonly type?: string;
}

/**
 * Describes an OpenSeadragon tile source as a {@link TilePyramid}, or `null`
 * when it cannot (custom tile sources whose URLs do not embed level/x/y).
 *
 * URLs are derived by probing `getTileUrl` with sentinel numbers and turning
 * them back into placeholders, which works for DZI and any template-style
 * source without special-casing OSD's classes.
 */
export function describeOsdTileSource(ts: OsdTileSourceLike): TilePyramid | null {
  const width = ts.width ?? ts.dimensions?.x;
  const height = ts.height ?? ts.dimensions?.y;
  if (!width || !height) return null;
  if (typeof ts.url === 'string' && (ts.type === 'image' || !ts.getTileUrl)) {
    return { kind: 'image', width, height, url: ts.url };
  }
  if (!ts.getTileUrl || ts.maxLevel === undefined) return null;
  // OSD levels for DZI run 0..maxLevel with maxLevel = ceil(log2(max side)).
  if (ts.maxLevel !== dziMaxLevel(width, height)) return null;
  const L = 7919;
  const X = 7927;
  const Y = 7933;
  const probe = ts.getTileUrl(L, X, Y);
  if (typeof probe !== 'string') return null;
  if (!probe.includes(String(L)) || !probe.includes(String(X)) || !probe.includes(String(Y))) return null;
  const tileUrlTemplate = probe
    .replace(String(L), '{level}')
    .replace(String(X), '{x}')
    .replace(String(Y), '{y}');
  return {
    kind: 'dzi',
    width,
    height,
    tileSize: ts.getTileWidth?.(ts.maxLevel) ?? 254,
    overlap: ts.tileOverlap ?? 0,
    tileUrlTemplate,
  };
}
