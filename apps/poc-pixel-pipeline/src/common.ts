import OpenSeadragon from 'openseadragon';
import { DEFAULT_VIEWER_OPTIONS } from '@osdlabel/osd-helper';
import type { GrayscaleRaster, VoiWindow } from '@osdlabel/pixel';
import { buildPyramid, IDENTITY_RESCALE, measureRange } from '@osdlabel/pixel';
import type { RasterTileSource } from '@osdlabel/osd-pixel';
import { createRasterTileSource, VoiState } from '@osdlabel/osd-pixel';
import { ctHeadPhantom, mammoPhantom, quantizeToRgba8, valueRamp } from './data/phantoms.js';

export type ImageName = 'ct' | 'mammo' | 'ramp';

export interface LoadedImage {
  readonly name: ImageName;
  readonly full: GrayscaleRaster;
  readonly levels: readonly GrayscaleRaster[];
  readonly range: { readonly min: number; readonly max: number };
  readonly windows: readonly VoiWindow[];
  readonly genMs: number;
}

const images = new Map<ImageName, LoadedImage>();

/**
 * A deterministic W/L drag: `n` windows sweeping centre and width the way a
 * mouse drag does (both change every step).
 */
function dragPath(n: number, c0: number, c1: number, w0: number, w1: number): VoiWindow[] {
  const out: VoiWindow[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    const tri = t < 0.5 ? t * 2 : 2 - t * 2;
    out.push({ center: Math.round(c0 + (c1 - c0) * tri), width: Math.round(w0 + (w1 - w0) * t) });
  }
  return out;
}

export function getImage(name: ImageName): LoadedImage {
  const cached = images.get(name);
  if (cached) return cached;
  const t0 = performance.now();
  const full = name === 'ct' ? ctHeadPhantom(512) : name === 'mammo' ? mammoPhantom() : valueRamp();
  const levels = buildPyramid(full);
  const range = measureRange(full.data);
  const windows =
    name === 'mammo'
      ? dragPath(240, 22000, 42000, 2000, 30000)
      : dragPath(240, -100, 300, 80, 2000);
  const img: LoadedImage = { name, full, levels, range, windows, genMs: performance.now() - t0 };
  images.set(name, img);
  return img;
}

export const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame((t) => resolve(t)));

export async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

/** A fixed-size host element for a viewer. */
export function host(id: string, width: number, height: number): HTMLElement {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    background: '#000',
  });
  document.body.appendChild(el);
  return el;
}

export type DrawerChoice = OpenSeadragon.Options['drawer'];

/** osdlabel's cell options, plus what the harness needs to be deterministic. */
export function createViewer(
  element: HTMLElement,
  drawer: DrawerChoice | undefined,
  extra: Partial<OpenSeadragon.Options> = {},
): OpenSeadragon.Viewer {
  return OpenSeadragon({
    ...DEFAULT_VIEWER_OPTIONS,
    element,
    ...(drawer !== undefined ? { drawer } : {}),
    immediateRender: true,
    blendTime: 0,
    animationTime: 0,
    ...extra,
  });
}

export function openAndWait(viewer: OpenSeadragon.Viewer, tileSource: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    viewer.addOnceHandler('open', () => resolve());
    viewer.addOnceHandler('open-failed', (e) => reject(new Error(String(e.message))));
    viewer.open(tileSource as OpenSeadragon.TileSource);
  });
}

interface FullyLoadable {
  getFullyLoaded(): boolean;
}

function isFullyLoadable(v: unknown): v is FullyLoadable {
  return typeof (v as { getFullyLoaded?: unknown } | null)?.getFullyLoaded === 'function';
}

/** Wait until every tile the current view needs is loaded and drawn. */
export async function waitFullyLoaded(
  viewer: OpenSeadragon.Viewer,
  timeoutMs = 30000,
): Promise<void> {
  const t0 = performance.now();
  for (;;) {
    await nextFrame();
    const item: unknown = viewer.world.getItemAt(0);
    if (isFullyLoadable(item) && item.getFullyLoaded()) break;
    if (performance.now() - t0 > timeoutMs) throw new Error('tiles did not finish loading');
  }
  viewer.forceRedraw();
  await frames(3);
}

export type ZoomMode = 'fit' | '1:1';

export async function setZoom(viewer: OpenSeadragon.Viewer, mode: ZoomMode): Promise<void> {
  const vp = viewer.viewport;
  if (mode === 'fit') {
    vp.goHome(true);
  } else {
    vp.zoomTo(vp.imageToViewportZoom(1), undefined, true);
    const item = viewer.world.getItemAt(0);
    vp.panTo(item.getBounds().getCenter(), true);
  }
  viewer.forceRedraw();
  await waitFullyLoaded(viewer);
}

/** A raster source + VOI state for `img`, opened in a new viewer. */
export interface RasterViewer {
  readonly viewer: OpenSeadragon.Viewer;
  readonly voi: VoiState;
  readonly source: RasterTileSource;
  readonly img: LoadedImage;
}

let sourceSeq = 0;

export async function openRasterViewer(
  element: HTMLElement,
  img: LoadedImage,
  drawer: DrawerChoice,
  drawerOptions: Record<string, unknown> | undefined,
  tileSize = 256,
  extra: Partial<OpenSeadragon.Options> = {},
): Promise<RasterViewer> {
  const voi = new VoiState(img.range, {
    rescale: IDENTITY_RESCALE,
    window: img.windows[0]!,
    invert: false,
  });
  const source = createRasterTileSource({
    levels: img.levels,
    tileSize,
    voi,
    id: `${img.name}-${sourceSeq++}`,
  });
  const resolvedDrawerOptions =
    typeof drawerOptions === 'object' ? { custom: { voi, ...drawerOptions } } : undefined;
  const viewer = createViewer(element, drawer, {
    ...(resolvedDrawerOptions ? { drawerOptions: resolvedDrawerOptions } : {}),
    ...extra,
  });
  await openAndWait(viewer, source.tileSource);
  await waitFullyLoaded(viewer);
  return { viewer, voi, source, img };
}

/** An 8-bit, full-range-quantised copy of `raster` as a blob URL PNG. */
export async function eightBitUrl(
  raster: GrayscaleRaster,
  min: number,
  max: number,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d');
  const id = new ImageData(raster.width, raster.height);
  id.data.set(quantizeToRgba8(raster, min, max));
  ctx.putImageData(id, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
  return URL.createObjectURL(blob);
}

export function summarize(samples: readonly number[]): {
  n: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
} {
  if (samples.length === 0) return { n: 0, mean: 0, median: 0, p95: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1]!,
  };
}

/** Force the 2D canvas's pending draws to rasterise (CPU-path completion). */
export function flush2d(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.getImageData(0, 0, 1, 1);
}

/** Run `onFrame` once per animation frame for `ms`, returning frame intervals. */
export function rafLoop(ms: number, onFrame: (i: number) => void): Promise<number[]> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let start = -1;
    let last = 0;
    let i = 0;
    const tick = (now: number): void => {
      if (start < 0) {
        start = now;
      } else {
        intervals.push(now - last);
      }
      last = now;
      onFrame(i++);
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve(intervals);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * `viewer.drawer.getType()`. `@types/openseadragon` 5.0.2 still types
 * `viewer.drawer` as the OSD 4 `Drawer` class, which has no `getType`.
 */
export function drawerType(viewer: OpenSeadragon.Viewer): string {
  const d = viewer.drawer as unknown as { getType?: () => string } | null;
  return d?.getType?.() ?? 'none';
}

/**
 * Tiles in the viewer's cache, and an estimate of their CPU-side bytes: raw
 * stored values (2 B/px) for every cached tile, plus a rendered RGBA canvas
 * (4 B/px) when the CPU path has produced one.
 */
export function cachedTileMemory(
  viewer: OpenSeadragon.Viewer,
  tileSize: number,
  cpuCanvases: boolean,
): {
  tiles: number;
  rawMB: number;
  canvasMB: number;
} {
  const cache = (viewer as unknown as { tileCache?: { numTilesLoaded(): number } }).tileCache;
  const tiles = cache ? cache.numTilesLoaded() : 0;
  const px = tiles * tileSize * tileSize;
  return { tiles, rawMB: (px * 2) / 1048576, canvasMB: cpuCanvases ? (px * 4) / 1048576 : 0 };
}

export function jsHeapMB(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
}
