import { planRegionRead, type Region, type RegionReadPlan } from './plan.js';
import type { TilePyramid } from './pyramid.js';

/** RGBA pixels, row-major, like `ImageData` but constructible anywhere. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** What reading needs from the platform; the browser/worker default is {@link browserTileIO}. */
export interface TileIO {
  loadBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap>;
  createCanvas(width: number, height: number): OffscreenCanvas;
}

export interface RegionReadResult extends RgbaImage {
  readonly plan: RegionReadPlan | null;
  readonly tileCount: number;
  /** ms: tile fetch + decode, compositing + resample, pixel readback. */
  readonly timings: { readonly fetch: number; readonly composite: number; readback: number };
}

/**
 * The platform default: `fetch` + `createImageBitmap` + `OffscreenCanvas`,
 * all of which exist in dedicated workers. Tiles are fetched with the normal
 * HTTP cache, so tiles OpenSeadragon already loaded are not downloaded twice.
 * Bitmaps are kept in a small LRU (decoded tiles are what a re-encode after a
 * small pan needs again).
 */
export function browserTileIO(options?: { readonly maxCachedBitmaps?: number }): TileIO {
  const cache = new Map<string, Promise<ImageBitmap>>();
  const max = options?.maxCachedBitmaps ?? 256;
  return {
    loadBitmap(url, signal) {
      const hit = cache.get(url);
      if (hit) {
        cache.delete(url);
        cache.set(url, hit);
        return hit;
      }
      const p = fetch(url, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`tile ${url}: HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => createImageBitmap(b));
      p.catch(() => cache.delete(url));
      cache.set(url, p);
      while (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        void cache.get(oldest)?.then((bmp) => bmp.close(), () => {});
        cache.delete(oldest);
      }
      return p;
    },
    createCanvas: (w, h) => new OffscreenCanvas(w, h),
  };
}

function ctx2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

/**
 * Reads `region` (level-0 image px) of a pyramid at `outWidth x outHeight`,
 * straight from its tiles: the pixels a model should see, at the resolution
 * it wants, with nothing the viewer draws on top.
 */
export async function readRegion(
  pyramid: TilePyramid,
  region: Region,
  outWidth: number,
  outHeight: number,
  io: TileIO,
  signal: AbortSignal,
): Promise<RegionReadResult> {
  const t0 = performance.now();
  const out = io.createCanvas(outWidth, outHeight);
  const octx = ctx2d(out);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';

  if (pyramid.kind === 'image') {
    const bmp = await io.loadBitmap(pyramid.url, signal);
    const t1 = performance.now();
    octx.drawImage(bmp, region.x, region.y, region.width, region.height, 0, 0, outWidth, outHeight);
    const t2 = performance.now();
    const data = octx.getImageData(0, 0, outWidth, outHeight).data;
    const t3 = performance.now();
    return {
      width: outWidth,
      height: outHeight,
      data,
      plan: null,
      tileCount: 1,
      timings: { fetch: t1 - t0, composite: t2 - t1, readback: t3 - t2 },
    };
  }

  const plan = planRegionRead(pyramid, region, outWidth, outHeight);
  const bitmaps = await Promise.all(plan.tiles.map((t) => io.loadBitmap(t.url, signal)));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const t1 = performance.now();
  const level = io.createCanvas(Math.max(1, plan.levelRect.width), Math.max(1, plan.levelRect.height));
  const lctx = ctx2d(level);
  plan.tiles.forEach((t, i) => {
    lctx.drawImage(bitmaps[i]!, t.sx, t.sy, t.w, t.h, t.dx, t.dy, t.w, t.h);
  });
  octx.drawImage(
    level,
    plan.crop.x,
    plan.crop.y,
    plan.crop.width,
    plan.crop.height,
    0,
    0,
    outWidth,
    outHeight,
  );
  const t2 = performance.now();
  const data = octx.getImageData(0, 0, outWidth, outHeight).data;
  const t3 = performance.now();
  return {
    width: outWidth,
    height: outHeight,
    data,
    plan,
    tileCount: plan.tiles.length,
    timings: { fetch: t1 - t0, composite: t2 - t1, readback: t3 - t2 },
  };
}
