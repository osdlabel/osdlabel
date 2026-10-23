import OpenSeadragon from 'openseadragon';
import type { DisplayTransform, VoiLut } from '@osdlabel/pixel';
import {
  applyVoiDirectRgba32,
  applyVoiLutBytes,
  applyVoiLutRgba32,
  buildVoiLut,
  IDENTITY_RESCALE,
} from '@osdlabel/pixel';
import type { ImageName, ZoomMode } from './common.js';
import {
  cachedTileMemory,
  drawerType,
  flush2d,
  frames,
  getImage,
  host,
  jsHeapMB,
  openRasterViewer,
  rafLoop,
  setZoom,
  summarize,
} from './common.js';

/**
 * H2: the CPU path. Three experiments:
 *
 * - `h2Full`: re-window a whole image per W/L step (what you do with one big
 *   canvas, or a non-tiled source), single-threaded, three loop variants.
 * - `h2Workers`: the same, split across a worker pool over SharedArrayBuffers.
 * - `h2Osd`: inside OpenSeadragon, with the raster tile source re-windowing
 *   only the tiles the current view draws (lazily, from the CanvasDrawer).
 */

export type LoopImpl = 'lut32' | 'lutBytes' | 'direct';

const VIEW = 1024;

function transform(img: ReturnType<typeof getImage>, i: number): DisplayTransform {
  return {
    rescale: IDENTITY_RESCALE,
    window: img.windows[i % img.windows.length]!,
    invert: false,
  };
}

export async function h2Full(image: ImageName, impl: LoopImpl, steps: number): Promise<object> {
  const img = getImage(image);
  const { width, height, data } = img.full;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const view = document.createElement('canvas');
  view.width = VIEW;
  view.height = VIEW;
  document.body.appendChild(view);
  const vctx = view.getContext('2d');
  if (!ctx || !vctx) throw new Error('no 2d');
  const imageData = new ImageData(width, height);
  const u32 = new Uint32Array(imageData.data.buffer);
  const lutMs: number[] = [];
  const applyMs: number[] = [];
  const putMs: number[] = [];
  const displayMs: number[] = [];
  const totalMs: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = transform(img, i);
    const t0 = performance.now();
    let lut: VoiLut | null = null;
    if (impl !== 'direct') lut = buildVoiLut(img.range, t);
    const t1 = performance.now();
    if (impl === 'lut32' && lut) applyVoiLutRgba32(data, lut, u32);
    else if (impl === 'lutBytes' && lut) applyVoiLutBytes(data, lut, imageData.data);
    else applyVoiDirectRgba32(data, t, u32);
    const t2 = performance.now();
    ctx.putImageData(imageData, 0, 0);
    flush2d(canvas);
    const t3 = performance.now();
    const scale = Math.min(VIEW / width, VIEW / height);
    vctx.drawImage(canvas, 0, 0, width * scale, height * scale);
    flush2d(view);
    const t4 = performance.now();
    lutMs.push(t1 - t0);
    applyMs.push(t2 - t1);
    putMs.push(t3 - t2);
    displayMs.push(t4 - t3);
    totalMs.push(t4 - t0);
    if (i % 8 === 7) await frames(1); // let the page breathe
  }
  view.remove();
  canvas.width = canvas.height = 0;
  return {
    image,
    impl,
    pixels: width * height,
    lutEntries: img.range.max - img.range.min + 1,
    lut: summarize(lutMs),
    apply: summarize(applyMs),
    putImageData: summarize(putMs),
    displayDrawImage: summarize(displayMs),
    total: summarize(totalMs),
  };
}

interface Pool {
  readonly workers: Worker[];
  readonly src: SharedArrayBuffer;
  readonly dst: SharedArrayBuffer;
}

async function makePool(image: ImageName, n: number): Promise<Pool> {
  const img = getImage(image);
  const data = img.full.data;
  const src = new SharedArrayBuffer(data.byteLength);
  if (data instanceof Int16Array) new Int16Array(src).set(data);
  else new Uint16Array(src).set(data);
  const dst = new SharedArrayBuffer(data.length * 4);
  const workers: Worker[] = [];
  await Promise.all(
    Array.from({ length: n }, () => {
      const w = new Worker(new URL('./voi-worker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      return new Promise<void>((resolve) => {
        w.onmessage = () => resolve();
        w.postMessage({ type: 'init', src, signed: data instanceof Int16Array, dst });
      });
    }),
  );
  return { workers, src, dst };
}

export async function h2Workers(image: ImageName, workers: number, steps: number): Promise<object> {
  if (!crossOriginIsolated) throw new Error('SharedArrayBuffer needs cross-origin isolation');
  const img = getImage(image);
  const { width, height } = img.full;
  const pool = await makePool(image, workers);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d');
  const imageData = new ImageData(width, height);
  const size = img.range.max - img.range.min + 1;
  const lutBuf = new SharedArrayBuffer(size * 4);
  const lutView = new Uint32Array(lutBuf);
  const n = width * height;
  const wallMs: number[] = [];
  const mainBlockedMs: number[] = [];
  const workerMs: number[] = [];
  const copyMs: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    lutView.set(buildVoiLut(img.range, transform(img, i)).rgba32);
    const t1 = performance.now();
    const per = Math.ceil(n / workers);
    const results = await Promise.all(
      pool.workers.map(
        (w, k) =>
          new Promise<number>((resolve) => {
            w.onmessage = (e: MessageEvent<{ ms: number }>) => resolve(e.data.ms);
            w.postMessage({
              type: 'apply',
              lut: lutBuf,
              min: img.range.min,
              start: k * per,
              end: Math.min(n, (k + 1) * per),
            });
          }),
      ),
    );
    const t2 = performance.now();
    // ImageData cannot wrap shared memory: one copy out of the SAB.
    imageData.data.set(new Uint8Array(pool.dst));
    const t3 = performance.now();
    ctx.putImageData(imageData, 0, 0);
    flush2d(canvas);
    const t4 = performance.now();
    wallMs.push(t4 - t0);
    mainBlockedMs.push(t1 - t0 + (t4 - t2));
    workerMs.push(Math.max(...results));
    copyMs.push(t3 - t2);
  }
  for (const w of pool.workers) w.terminate();
  canvas.width = canvas.height = 0;
  return {
    image,
    workers,
    pixels: n,
    wall: summarize(wallMs),
    mainThreadBlocked: summarize(mainBlockedMs),
    slowestWorker: summarize(workerMs),
    sabCopy: summarize(copyMs),
  };
}

export type H2Drawer = 'canvas' | 'webgl-stock';

/**
 * The tiled CPU path inside OSD at a given zoom. With the CanvasDrawer every
 * W/L step re-windows only the tiles being drawn. With OSD's WebGLDrawer the
 * re-windowed canvases never reach the GPU (textures are uploaded once, at
 * `tile-ready`): we show that, then measure the private-API workaround.
 */
export async function h2Osd(
  image: ImageName,
  zoom: ZoomMode,
  drawer: H2Drawer,
  steps: number,
  rafMs: number,
  viewSize = VIEW,
): Promise<object> {
  const img = getImage(image);
  const el = host('h2', viewSize, viewSize);
  const heapBefore = jsHeapMB();
  const rv = await openRasterViewer(el, img, drawer === 'canvas' ? 'canvas' : 'webgl', undefined);
  const { viewer, voi, source } = rv;
  await setZoom(viewer, zoom);
  const drawerCanvas = viewer.drawer.canvas as HTMLCanvasElement;
  const drawerKind = drawerType(viewer);

  // Does a W/L change reach the screen at all?
  const probe = (): number => {
    const c = drawerCanvas.getContext('2d');
    return c ? c.getImageData(viewSize / 2, viewSize / 2, 1, 1).data[0]! : -1;
  };
  voi.setWindow({ center: img.range.min, width: 2 }); // everything white
  viewer.world.draw();
  const whiteProbe = probe();
  voi.setWindow({ center: img.range.max, width: 2 }); // everything black
  viewer.world.draw();
  const blackProbe = probe();
  const wlReachesScreen = whiteProbe === 255 && blackProbe === 0;

  const unload = (): void => {
    const d = viewer.drawer as unknown as { _unloadTextures?: () => void };
    d._unloadTextures?.();
  };

  const syncMs: number[] = [];
  const completeMs: number[] = [];
  const tiles: number[] = [];
  const pixels: number[] = [];
  const lutMs: number[] = [];
  const putMs: number[] = [];
  for (let i = 0; i < steps; i++) {
    source.resetStats();
    const t0 = performance.now();
    voi.setWindow(img.windows[i % img.windows.length]!);
    if (drawer === 'webgl-stock') unload(); // private API: force re-upload
    viewer.world.draw();
    const t1 = performance.now();
    flush2d(drawerCanvas);
    const t2 = performance.now();
    syncMs.push(t1 - t0);
    completeMs.push(t2 - t0);
    tiles.push(source.stats.tilesReprocessed);
    pixels.push(source.stats.pixelsReprocessed);
    lutMs.push(source.stats.lutMs);
    putMs.push(source.stats.putImageDataMs);
    if (i % 8 === 7) await frames(1);
  }

  let k = 0;
  const intervals = await rafLoop(rafMs, () => {
    voi.setWindow(img.windows[k++ % img.windows.length]!);
    if (drawer === 'webgl-stock') unload();
    viewer.world.draw();
  });
  const frameStats = summarize(intervals);
  const memory = {
    ...cachedTileMemory(viewer, 256, true),
    jsHeapDeltaMB: heapBefore !== null ? (jsHeapMB() ?? 0) - heapBefore : null,
  };
  viewer.destroy();
  el.remove();
  return {
    image,
    zoom,
    drawer,
    drawerType: drawerKind,
    viewport: `${viewSize}x${viewSize}`,
    devicePixelRatio: OpenSeadragon.pixelDensityRatio,
    wlReachesScreenWithoutPrivateApi: wlReachesScreen,
    tilesPerStep: summarize(tiles),
    pixelsPerStep: summarize(pixels),
    lutApplyMsPerStep: summarize(lutMs),
    putImageDataMsPerStep: summarize(putMs),
    drawSync: summarize(syncMs),
    drawComplete: summarize(completeMs),
    raf: { ...frameStats, fps: frameStats.mean > 0 ? 1000 / frameStats.mean : 0 },
    memory,
  };
}
