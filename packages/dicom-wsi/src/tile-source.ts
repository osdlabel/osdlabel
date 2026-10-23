import type { FrameDecoderRegistry } from './decoders.js';
import { browserJpegDecoder, createFrameDecoderRegistry, nativeDecoder } from './decoders.js';
import type { FrameSource } from './frame-source.js';
import type { WsiPyramid } from './pyramid.js';
import { frameNumberFor } from './pyramid.js';

/** Per-tile timings, for the benchmark (and for a host's own telemetry). */
export interface TileStat {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly fetchMs: number;
  readonly decodeMs: number;
  readonly bytes: number;
  readonly ok: boolean;
}

/** The subset of OpenSeadragon's ImageJob this tile source touches. */
interface OsdImageJob {
  readonly tile: { readonly level: number; readonly x: number; readonly y: number };
  readonly userData: { abort?: AbortController };
  finish(data: unknown, request: unknown, errorMessage?: string): void;
}

/**
 * The OpenSeadragon custom-tile-source protocol, as a plain object: OSD wraps
 * any object with a `getTileUrl` function in `new TileSource(options)`, which
 * copies every property — including these method overrides — onto the
 * instance. So this package never imports OpenSeadragon, and the object is a
 * valid osdlabel `ImageSource.tileSource` as is.
 */
export interface WsiTileSourceSpec {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly tileOverlap: 0;
  readonly minLevel: 0;
  readonly maxLevel: number;
  getTileUrl(level: number, x: number, y: number): string;
  getLevelScale(level: number): number;
  getTileWidth(level: number): number;
  getTileHeight(level: number): number;
  downloadTileStart(context: OsdImageJob): void;
  downloadTileAbort(context: OsdImageJob): void;
}

export interface WsiTileSourceOptions {
  readonly pyramid: WsiPyramid;
  readonly frames: FrameSource;
  readonly decoders?: FrameDecoderRegistry;
  readonly onTile?: (stat: TileStat) => void;
}

/**
 * An OpenSeadragon tile source over a DICOM WSI pyramid. OSD levels map 1:1
 * onto DICOM levels, each reporting its true scale (`getLevelScale`), so a 4×
 * DICOM pyramid needs no resampling or synthetic levels: OSD picks the level
 * whose resolution best matches the screen.
 */
export function createWsiTileSource(options: WsiTileSourceOptions): WsiTileSourceSpec {
  const { pyramid, frames } = options;
  const decoders =
    options.decoders ?? createFrameDecoderRegistry([browserJpegDecoder, nativeDecoder]);
  const levels = pyramid.levels;
  const base = levels[levels.length - 1]!;
  return {
    width: pyramid.width,
    height: pyramid.height,
    tileSize: base.tileWidth,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: levels.length - 1,
    getTileUrl(level, x, y) {
      const l = levels[level]!;
      return `dicom-wsi:${l.sopInstanceUid}/frames/${frameNumberFor(l, x, y) ?? 0}`;
    },
    // Width ratio is exact for the level OSD sizes tiles by; heights round
    // independently in DICOM (e.g. 6985/4 → 1746), a < 1 px discrepancy at
    // that level which OSD clips.
    getLevelScale: (level) => levels[level]!.width / pyramid.width,
    getTileWidth: (level) => levels[level]!.tileWidth,
    getTileHeight: (level) => levels[level]!.tileHeight,
    downloadTileStart(context) {
      const { level, x, y } = context.tile;
      const l = levels[level];
      const n = l && frameNumberFor(l, x, y);
      if (!l || n === undefined) {
        context.finish(null, null, 'tile not stored (TILED_SPARSE)');
        return;
      }
      const ac = new AbortController();
      context.userData.abort = ac;
      const t0 = performance.now();
      void (async () => {
        let fetchMs = 0;
        let bytes = 0;
        try {
          const f = await frames.frame(l.sopInstanceUid, n, ac.signal);
          fetchMs = performance.now() - t0;
          bytes = f.bytes.length;
          const decoder = decoders.find(f.transferSyntaxUid);
          if (!decoder) throw new Error(`no decoder for ${f.transferSyntaxUid}`);
          const t1 = performance.now();
          const bitmap = await decoder.decode(
            f.bytes,
            {
              width: l.tileWidth,
              height: l.tileHeight,
              photometric: l.photometric,
              samplesPerPixel: l.samplesPerPixel,
              transferSyntaxUid: f.transferSyntaxUid,
            },
            ac.signal,
          );
          options.onTile?.({
            level,
            x,
            y,
            fetchMs,
            decodeMs: performance.now() - t1,
            bytes,
            ok: true,
          });
          context.finish(bitmap, null);
        } catch (err) {
          options.onTile?.({ level, x, y, fetchMs, decodeMs: 0, bytes, ok: false });
          context.finish(null, null, String(err));
        }
      })();
    },
    downloadTileAbort(context) {
      context.userData.abort?.abort();
    },
  };
}
