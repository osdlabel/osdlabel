import OpenSeadragon from 'openseadragon';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import { displayValue, extractRegion } from '@osdlabel/pixel';
import type { TextureFormat } from '@osdlabel/osd-pixel';
import { GlRenderer, VoiWebGLDrawer } from '@osdlabel/osd-pixel';
import type { GlTargetKind } from '@osdlabel/osd-pixel';
import type { ImageName, ZoomMode } from './common.js';
import {
  cachedTileMemory,
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
 * H3: the GPU path. Texture upload cost per format, W/L drag frame time in
 * OSD with the VOI drawer, pixel equivalence with the CPU path, and
 * registration against osdlabel's FabricOverlay.
 */

const VIEW = 1024;

export type UploadFormat = TextureFormat | 'rgba8';

/** Upload `count` tiles of `tileSize`² from the mammogram, one context, and time it. */
export async function h3Upload(
  format: UploadFormat,
  tileSize: number,
  count: number,
): Promise<object> {
  const img = getImage('mammo');
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('no webgl2');
  const r = new GlRenderer(gl);
  const tilesX = Math.floor(img.full.width / tileSize);
  const sources = Array.from({ length: count }, (_, i) =>
    extractRegion(
      img.full,
      (i % tilesX) * tileSize,
      Math.floor(i / tilesX) * tileSize,
      tileSize,
      tileSize,
    ),
  );
  // 8-bit baseline: what OSD's WebGLDrawer uploads, an RGBA canvas per tile.
  const canvases =
    format === 'rgba8'
      ? sources.map((s) => {
          const c = document.createElement('canvas');
          c.width = s.width;
          c.height = s.height;
          const ctx = c.getContext('2d');
          const id = new ImageData(s.width, s.height);
          for (let k = 0; k < s.data.length; k++) {
            const g = s.data[k]! >> 8;
            id.data[k * 4] = id.data[k * 4 + 1] = id.data[k * 4 + 2] = g;
            id.data[k * 4 + 3] = 255;
          }
          ctx?.putImageData(id, 0, 0);
          return c;
        })
      : [];
  const per: number[] = [];
  const pixel = new Uint8Array(4);
  const textures = [];
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    const a = performance.now();
    const t =
      format === 'rgba8'
        ? r.uploadCanvas(canvases[i]!, true)
        : r.uploadRaster(sources[i]!, format, true);
    textures.push(t);
    per.push(performance.now() - a);
  }
  const submitted = performance.now();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const done = performance.now();
  for (const t of textures) r.deleteTexture(t);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    format,
    tileSize,
    count,
    floatLinearFiltering: r.floatLinear,
    bytesPerTile: tileSize * tileSize * (format === 'rgba8' || format === 'r32f' ? 4 : 2),
    cpuPerTile: summarize(per),
    totalMsInclGpu: done - t0,
    gpuDrainMs: done - submitted,
    msPerTileInclGpu: (done - t0) / count,
    mbPerSecond: (count * tileSize * tileSize * 2) / 1048576 / ((done - t0) / 1000),
  };
}

/** W/L drag in OSD with the VOI drawer. */
export async function h3Osd(
  image: ImageName,
  zoom: ZoomMode,
  format: TextureFormat,
  target: GlTargetKind,
  steps: number,
  rafMs: number,
  viewSize = VIEW,
): Promise<object> {
  const img = getImage(image);
  const el = host('h3', viewSize, viewSize);
  const heapBefore = jsHeapMB();
  const rv = await openRasterViewer(el, img, VoiWebGLDrawer, { format, target });
  const { viewer, voi } = rv;
  await setZoom(viewer, zoom);
  const drawer = viewer.drawer as unknown as VoiWebGLDrawer;
  const rs = drawer.rendererStats;
  const loadUploads = rs ? { count: rs.uploads, ms: rs.uploadMs, bytes: rs.uploadBytes } : null;
  const uploadsBefore = rs?.uploads ?? 0;

  const syncMs: number[] = [];
  const completeMs: number[] = [];
  const tilesBefore = drawer.stats.tilesDrawn;
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    voi.setWindow(img.windows[i % img.windows.length]!);
    viewer.world.draw();
    const t1 = performance.now();
    drawer.finish();
    const t2 = performance.now();
    syncMs.push(t1 - t0);
    completeMs.push(t2 - t0);
    if (i % 8 === 7) await frames(1);
  }
  const tilesPerFrame = (drawer.stats.tilesDrawn - tilesBefore) / steps;
  const uploadsDuringDrag = (drawer.rendererStats?.uploads ?? 0) - uploadsBefore;

  let k = 0;
  const intervals = await rafLoop(rafMs, () => {
    voi.setWindow(img.windows[k++ % img.windows.length]!);
    viewer.world.draw();
  });
  const frameStats = summarize(intervals);
  const live = drawer.rendererStats;
  const result = {
    image,
    zoom,
    format,
    target,
    viewport: `${viewSize}x${viewSize}`,
    tilesPerFrame,
    uploadsDuringDrag,
    loadUploads,
    liveTextures: live?.liveTextures ?? null,
    liveTextureMB: live ? live.liveTextureBytes / 1048576 : null,
    jsHeapDeltaMB: heapBefore !== null ? (jsHeapMB() ?? 0) - heapBefore : null,
    cachedTiles: cachedTileMemory(viewer, 256, false),
    drawSync: summarize(syncMs),
    drawComplete: summarize(completeMs),
    raf: { ...frameStats, fps: frameStats.mean > 0 ? 1000 / frameStats.mean : 0 },
  };
  viewer.destroy();
  el.remove();
  return result;
}

function readCanvas(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no 2d');
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

export type EquivalenceReference = 'canvas' | 'webgl';

/**
 * Pixel equivalence: the same view through a reference OSD drawer fed
 * re-windowed 8-bit tiles (the CPU path) and through the VOI drawer.
 *
 * `canvas` is OSD's CanvasDrawer (the CPU path's natural drawer). `webgl` is
 * OSD's own WebGLDrawer, which shares the VOI drawer's matrices; it is given
 * fresh textures per window through its private `_unloadTextures` (fine for a
 * reference, not for production). `shiftTolerant` counts a pixel as matching
 * when the reference has the same grey within one pixel of it, separating
 * sub-pixel placement differences from value differences.
 */
export async function h3Equivalence(
  image: ImageName,
  rotation: number,
  flip: boolean,
  smoothing: boolean,
  format: TextureFormat,
  reference: EquivalenceReference = 'canvas',
): Promise<object> {
  const img = getImage(image);
  const size = 512;
  const elA = host('eqA', size, size);
  const elB = host('eqB', size, size);
  elB.style.left = `${size}px`;
  const extra = { imageSmoothingEnabled: smoothing };
  const a = await openRasterViewer(elA, img, reference, undefined, 256, extra);
  const b = await openRasterViewer(elB, img, VoiWebGLDrawer, { format, target: 'own' }, 256, extra);
  const refreshA = (): void => {
    const d = a.viewer.drawer as unknown as { _unloadTextures?: () => void };
    if (reference === 'webgl') d._unloadTextures?.();
  };
  const results: object[] = [];
  for (const v of [a, b]) {
    v.viewer.viewport.setRotation(rotation, true);
    v.viewer.viewport.setFlip(flip);
    // An off-centre zoom: not the home view, not a whole number of pixels.
    v.viewer.viewport.zoomTo(v.viewer.viewport.imageToViewportZoom(1.37), undefined, true);
    v.viewer.viewport.panTo(new OpenSeadragon.Point(0.43, 0.38), true);
    v.viewer.forceRedraw();
  }
  await frames(2);
  for (const v of [a, b]) await setZoomNoop(v.viewer);
  for (const w of img.windows.filter((_, i) => i % 60 === 0)) {
    a.voi.setWindow(w);
    b.voi.setWindow(w);
    refreshA();
    a.viewer.world.draw();
    const pa = readCanvas(a.viewer.drawer.canvas as HTMLCanvasElement);
    b.viewer.world.draw();
    const pb = readCanvas(b.viewer.drawer.canvas as HTMLCanvasElement);
    let differing = 0;
    let over2 = 0;
    let maxDiff = 0;
    let sum = 0;
    let shiftMismatch = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const d = Math.abs(pa[i]! - pb[i]!);
        if (d > 0) differing++;
        if (d > 2) over2++;
        if (d > maxDiff) maxDiff = d;
        sum += d;
        if (d > 2) {
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1 && !near; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
              if (Math.abs(pa[(yy * size + xx) * 4]! - pb[i]!) <= 2) near = true;
            }
          }
          if (!near) shiftMismatch++;
        }
      }
    }
    const n = size * size;
    results.push({
      window: w,
      pixels: n,
      differingFraction: differing / n,
      over2Fraction: over2 / n,
      over2NotExplainedBy1pxShift: shiftMismatch / n,
      maxDiff,
      meanDiff: sum / n,
    });
  }
  a.viewer.destroy();
  b.viewer.destroy();
  elA.remove();
  elB.remove();
  return { image, rotation, flip, smoothing, format, reference, perWindow: results };
}

async function setZoomNoop(viewer: OpenSeadragon.Viewer): Promise<void> {
  // Wait for the tiles of the current (non-home) view.
  for (let i = 0; i < 600; i++) {
    await frames(1);
    const item = viewer.world.getItemAt(0) as unknown as { getFullyLoaded(): boolean };
    if (item.getFullyLoaded()) break;
  }
  viewer.forceRedraw();
  await frames(3);
}

/**
 * Registration with osdlabel's overlay: for each rotation/flip, map ramp
 * block centres to the screen through FabricOverlay.imageToScreen and check
 * the VOI drawer painted that block's value there.
 */
export async function h3Alignment(): Promise<object> {
  const img = getImage('ramp');
  const size = 512;
  const el = host('align', size, size);
  const rv = await openRasterViewer(el, img, VoiWebGLDrawer, { format: 'r16i' }, 64, {
    imageSmoothingEnabled: false,
  });
  const { viewer, voi } = rv;
  const overlay = new FabricOverlay(viewer);
  // LINEAR_EXACT over 256 values starting at v0: one grey level per value.
  const v0 = 0;
  voi.setWindow({ center: v0 + 128, width: 256, fn: 'LINEAR_EXACT' });
  const t = voi.transform;
  const side = img.full.width;
  const out: object[] = [];
  for (const rotation of [0, 90, 180, 270]) {
    for (const flippedH of [false, true]) {
      overlay.applyViewTransform({ ...DEFAULT_CELL_TRANSFORM, rotation, flippedH });
      viewer.world.draw();
      const px = readCanvas(viewer.drawer.canvas as HTMLCanvasElement);
      let ok = 0;
      let total = 0;
      const misses: object[] = [];
      for (let value = v0 + 1; value < v0 + 255; value += 7) {
        const k = value - img.range.min;
        const ix = (k % side) + 0.5;
        const iy = Math.floor(k / side) + 0.5;
        const s = overlay.imageToScreen({ x: ix, y: iy });
        const sx = Math.round(s.x);
        const sy = Math.round(s.y);
        const grey = px[(sy * size + sx) * 4]!;
        const expected = displayValue(value, t);
        total++;
        if (grey === expected) ok++;
        else if (misses.length < 3) misses.push({ value, ix, iy, sx, sy, grey, expected });
      }
      out.push({ rotation, flippedH, matched: ok, total, misses });
    }
  }
  overlay.destroy();
  viewer.destroy();
  el.remove();
  return { cases: out };
}
