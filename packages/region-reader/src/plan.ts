import {
  dziLevelScale,
  dziLevelSize,
  dziMaxLevel,
  dziTileUrl,
  type DziPyramid,
} from './pyramid.js';

/** A rectangle in level-0 image pixels (fractional allowed). */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One tile to draw: `src` within the tile image, `dst` within the level canvas. */
export interface TileDraw {
  readonly level: number;
  readonly tx: number;
  readonly ty: number;
  readonly url: string;
  readonly sx: number;
  readonly sy: number;
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
}

export interface RegionReadPlan {
  readonly level: number;
  readonly levelScale: number;
  /** Integer level-pixel rectangle composited before the final resample. */
  readonly levelRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** The exact (fractional) region within the level canvas, for the final resample. */
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly outWidth: number;
  readonly outHeight: number;
  readonly tiles: readonly TileDraw[];
}

/**
 * The coarsest level that still has at least the requested resolution, so the
 * final resample only ever shrinks (by less than 2x) — never enlarges.
 */
export function chooseLevel(p: DziPyramid, targetScale: number): number {
  const max = dziMaxLevel(p.width, p.height);
  const level = max + Math.ceil(Math.log2(Math.max(targetScale, 1e-12)) - 1e-9);
  return Math.max(0, Math.min(max, level));
}

/**
 * Which tiles to fetch, and where each lands, to produce `region` at
 * `outWidth x outHeight`. Pure: tested without a browser.
 *
 * Tiles are composited at level resolution into an integer-aligned canvas
 * (drawing them straight at a fractional scale leaves hairline seams), and
 * only each tile's core is drawn — its overlap belongs to the neighbour.
 */
export function planRegionRead(
  p: DziPyramid,
  region: Region,
  outWidth: number,
  outHeight: number,
): RegionReadPlan {
  const targetScale = Math.max(outWidth / region.width, outHeight / region.height);
  const level = chooseLevel(p, targetScale);
  const s = dziLevelScale(p, level);
  const { width: LW, height: LH } = dziLevelSize(p, level);
  const lx0 = Math.max(0, Math.floor(region.x * s));
  const ly0 = Math.max(0, Math.floor(region.y * s));
  const lx1 = Math.min(LW, Math.ceil((region.x + region.width) * s));
  const ly1 = Math.min(LH, Math.ceil((region.y + region.height) * s));
  const ts = p.tileSize;
  const ov = p.overlap;
  const tiles: TileDraw[] = [];
  for (let ty = Math.floor(ly0 / ts); ty * ts < ly1; ty++) {
    for (let tx = Math.floor(lx0 / ts); tx * ts < lx1; tx++) {
      // Core of the tile in level pixels, clipped to the request.
      const cx0 = Math.max(lx0, tx * ts);
      const cy0 = Math.max(ly0, ty * ts);
      const cx1 = Math.min(lx1, (tx + 1) * ts, LW);
      const cy1 = Math.min(ly1, (ty + 1) * ts, LH);
      if (cx1 <= cx0 || cy1 <= cy0) continue;
      // The tile image starts `ov` pixels before its core, except at the edges.
      const imgX0 = tx * ts - (tx > 0 ? ov : 0);
      const imgY0 = ty * ts - (ty > 0 ? ov : 0);
      tiles.push({
        level,
        tx,
        ty,
        url: dziTileUrl(p, level, tx, ty),
        sx: cx0 - imgX0,
        sy: cy0 - imgY0,
        dx: cx0 - lx0,
        dy: cy0 - ly0,
        w: cx1 - cx0,
        h: cy1 - cy0,
      });
    }
  }
  return {
    level,
    levelScale: s,
    levelRect: { x: lx0, y: ly0, width: lx1 - lx0, height: ly1 - ly0 },
    crop: {
      x: region.x * s - lx0,
      y: region.y * s - ly0,
      width: region.width * s,
      height: region.height * s,
    },
    outWidth,
    outHeight,
    tiles,
  };
}
