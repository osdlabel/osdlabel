import OpenSeadragon from 'openseadragon6';
import type { GrayscaleRaster, VoiWindow } from '@osdlabel/pixel';
import {
  applyVoiLutRgba32,
  buildPyramid,
  extractRegion,
  IDENTITY_RESCALE,
  measureRange,
} from '@osdlabel/pixel';
import { GlRenderer } from '@osdlabel/osd-pixel/gl-renderer';
import type { TileTexture } from '@osdlabel/osd-pixel/gl-renderer';
import { multiply, tileMatrix, viewMatrix } from '@osdlabel/osd-pixel/mat3';
import { VoiState } from '@osdlabel/osd-pixel/voi-state';
import { ctHeadPhantom, mammoPhantom } from './data/phantoms.js';

/**
 * Does the OSD 5 approach survive OpenSeadragon 6.1.1? The same pieces
 * (raw-raster tile source, VOI LUT CPU path, GlRenderer + OSD matrices) on
 * OSD 6's new data pipeline instead of the deprecated *TileCache hooks:
 *
 * - the tile source finishes jobs with a custom data type,
 *   `job.finish(data, null, 'osdlabel-raster16')`;
 * - the CPU path is a converter `osdlabel-raster16 -> context2d`, so every
 *   stock drawer can draw these tiles; a W/L change re-runs it through
 *   `viewer.requestInvalidate()`;
 * - the GPU drawer declares `getSupportedDataFormats()` and lets OSD manage
 *   its textures through `internalCacheCreate` / `internalCacheFree`.
 */

const RASTER = 'osdlabel-raster16';

interface RasterData {
  readonly raster: GrayscaleRaster;
}

const voiByViewer = new WeakMap<object, VoiState>();

function voiForTile(tile: OpenSeadragon.Tile): VoiState | undefined {
  const ti = (tile as unknown as { tiledImage?: { viewer?: object } }).tiledImage;
  return ti?.viewer ? voiByViewer.get(ti.viewer) : undefined;
}

let convertersLearned = false;
function learnConverters(): void {
  if (convertersLearned) return;
  convertersLearned = true;
  // CPU path: what every non-VOI drawer gets.
  OpenSeadragon.converter.learn(
    RASTER,
    'context2d',
    (tile: OpenSeadragon.Tile, data: RasterData) => {
      const voi = voiForTile(tile);
      const { width, height } = data.raster;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d')!;
      const id = new ImageData(width, height);
      if (voi) applyVoiLutRgba32(data.raster.data, voi.lut(), new Uint32Array(id.data.buffer));
      ctx.putImageData(id, 0, 0);
      return ctx;
    },
    1,
    1,
  );
  // Stored values are never mutated: a copy can share them.
  OpenSeadragon.converter.learn(RASTER, RASTER, (_t: OpenSeadragon.Tile, d: RasterData) => d, 0, 1);
}

function rasterTileSource(
  levels: readonly GrayscaleRaster[],
  tileSize: number,
): OpenSeadragon.TileSource {
  const full = levels[levels.length - 1]!;
  const ts = new OpenSeadragon.TileSource({
    width: full.width,
    height: full.height,
    tileSize,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: levels.length - 1,
  });
  const prefix = 'osd6-raster://';
  ts.getTileUrl = (level: number, x: number, y: number): string => `${prefix}${level}/${x}/${y}`;
  ts.hasTransparency = (): boolean => false;
  ts.downloadTileStart = (job: OpenSeadragon.ImageJob): void => {
    const [level, x, y] = job.src.slice(prefix.length).split('/').map(Number);
    const raster = level !== undefined ? levels[level] : undefined;
    if (!raster || x === undefined || y === undefined) {
      job.fail(`bad url ${job.src}`, null);
      return;
    }
    const data: RasterData = {
      raster: extractRegion(raster, x * tileSize, y * tileSize, tileSize, tileSize),
    };
    queueMicrotask(() => job.finish(data, null as unknown as XMLHttpRequest, RASTER));
  };
  ts.downloadTileAbort = (): void => {};
  return ts;
}

interface InternalTexture {
  readonly tex: TileTexture | null;
}

/** The OSD 5 VoiWebGLDrawer's draw loop, on OSD 6's drawer contract. */
class Voi6Drawer extends OpenSeadragon.DrawerBase {
  private _renderer: GlRenderer | null = null;
  private _smooth = true;
  stats = { frames: 0, tiles: 0, uploads: 0 };

  constructor(options: OpenSeadragon.DrawerConstructorParameters) {
    super(options);
    const gl = this.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error('no webgl2');
    this._renderer = new GlRenderer(gl);
  }

  override get defaultOptions(): OpenSeadragon.BaseDrawerOptions {
    // OSD owns texture lifetime: one internal cache entry per tile cache.
    return { usePrivateCache: true, preloadCache: false } as OpenSeadragon.BaseDrawerOptions;
  }

  static override isSupported(): boolean {
    return typeof WebGL2RenderingContext !== 'undefined';
  }

  override getType(): string {
    return 'osdlabel-voi6';
  }

  override getSupportedDataFormats(): string[] {
    return [RASTER, 'context2d'];
  }

  _createDrawingElement(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    const size = this.viewport.getContainerSize();
    c.width = Math.round(size.x * OpenSeadragon.pixelDensityRatio);
    c.height = Math.round(size.y * OpenSeadragon.pixelDensityRatio);
    return c;
  }

  override internalCacheCreate(cache: OpenSeadragon.CacheRecord): InternalTexture {
    const r = this._renderer;
    const data: unknown = (cache as unknown as { data: unknown }).data;
    if (!r) return { tex: null };
    this.stats.uploads++;
    if (data instanceof CanvasRenderingContext2D)
      return { tex: r.uploadCanvas(data.canvas, this._smooth) };
    return { tex: r.uploadRaster((data as RasterData).raster, 'r16i', this._smooth) };
  }

  override internalCacheFree(data: InternalTexture): void {
    if (data.tex) this._renderer?.deleteTexture(data.tex);
  }

  override canRotate(): boolean {
    return true;
  }

  override setImageSmoothingEnabled(enabled: boolean): void {
    this._smooth = enabled;
  }

  draw(tiledImages: OpenSeadragon.TiledImage[]): void {
    const r = this._renderer;
    if (!r) return;
    const gl = r.gl;
    const size = this.viewport.getContainerSize();
    const w = Math.round(size.x * OpenSeadragon.pixelDensityRatio);
    const h = Math.round(size.y * OpenSeadragon.pixelDensityRatio);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const bounds = this.viewport.getBoundsNoRotateWithMargins(true);
    const view = viewMatrix(bounds, this.viewport.getRotation(true), this.viewport.getFlip());
    const voi = voiByViewer.get(this.viewer);
    for (const item of tiledImages) {
      const infos = (
        item as unknown as { getTilesToDraw(): { tile: OpenSeadragon.Tile }[] }
      ).getTilesToDraw();
      for (const { tile } of infos) {
        const internal = this.getDataToDraw(tile) as InternalTexture | undefined;
        if (!internal?.tex) continue;
        const pb = (
          tile as unknown as {
            positionedBounds: { x: number; y: number; width: number; height: number };
          }
        ).positionedBounds;
        r.drawTile(
          internal.tex,
          multiply(view, tileMatrix(pb.x, pb.y, pb.width, pb.height)),
          [1, 1],
          voi ? voi.transform : null,
          this._smooth,
          1,
        );
        this.stats.tiles++;
      }
    }
    this.stats.frames++;
  }

  override destroy(): void {
    this.destroyInternalCache();
    this._renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this._renderer = null;
    this.canvas.remove();
    super.destroy(); // OSD 6: unregisters the drawer
  }

  finish(): void {
    const gl = this._renderer?.gl;
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

function windows(n: number, c0: number, c1: number, w0: number, w1: number): VoiWindow[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / Math.max(1, n - 1);
    const tri = t < 0.5 ? t * 2 : 2 - t * 2;
    return { center: Math.round(c0 + (c1 - c0) * tri), width: Math.round(w0 + (w1 - w0) * t) };
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

async function open(
  el: HTMLElement,
  name: 'ct' | 'mammo',
  drawer: 'canvas' | 'webgl' | 'voi',
): Promise<{ viewer: OpenSeadragon.Viewer; voi: VoiState; wins: VoiWindow[] }> {
  learnConverters();
  const full = name === 'ct' ? ctHeadPhantom(512) : mammoPhantom();
  const range = measureRange(full.data);
  const wins =
    name === 'ct' ? windows(60, -100, 300, 80, 2000) : windows(60, 22000, 42000, 2000, 30000);
  const voi = new VoiState(range, { rescale: IDENTITY_RESCALE, window: wins[0]!, invert: false });
  const viewer = OpenSeadragon({
    element: el,
    prefixUrl: '',
    showNavigationControl: false,
    animationTime: 0,
    blendTime: 0,
    immediateRender: true,
    imageSmoothingEnabled: false,
    drawer: drawer === 'voi' ? (Voi6Drawer as unknown as OpenSeadragon.DrawerConstructor) : drawer,
  });
  voiByViewer.set(viewer, voi);
  await new Promise<void>((resolve, reject) => {
    viewer.addOnceHandler('open', () => resolve());
    viewer.addOnceHandler('open-failed', () => reject(new Error('open failed')));
    viewer.open({ tileSource: rasterTileSource(buildPyramid(full), 256) });
  });
  for (let i = 0; i < 600; i++) {
    await nextFrame();
    const item = viewer.world.getItemAt(0) as unknown as { getFullyLoaded(): boolean };
    if (item.getFullyLoaded()) break;
  }
  for (let i = 0; i < 5; i++) await nextFrame();
  return { viewer, voi, wins };
}

function hostEl(id: string, left: number): HTMLElement {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, {
    position: 'absolute',
    left: `${left}px`,
    top: '0',
    width: '512px',
    height: '512px',
  });
  document.body.appendChild(el);
  return el;
}

function readPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

/** The probe: rendering, equivalence with OSD 6's stock drawer, W/L costs. */
async function run(): Promise<object> {
  const out: Record<string, unknown> = { osdVersion: OpenSeadragon.version.versionStr };
  // 1. GPU drawer vs OSD 6's own WebGLDrawer fed by the CPU converter.
  const a = await open(hostEl('a', 0), 'ct', 'webgl');
  const b = await open(hostEl('b', 512), 'ct', 'voi');
  const drawerB = b.viewer.drawer as unknown as Voi6Drawer;
  b.viewer.world.draw();
  const pa = readPixels(a.viewer.drawer.canvas);
  const pb = readPixels(b.viewer.drawer.canvas);
  let diff = 0;
  let over2 = 0;
  let nonBlank = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.abs(pa[i]! - pb[i]!);
    if (d > 0) diff++;
    if (d > 2) over2++;
    if (pb[i + 3]! > 0) nonBlank++;
  }
  const n = pa.length / 4;
  out['equivalence'] = {
    reference: 'OSD 6 WebGLDrawer + raster->context2d converter',
    differingFraction: diff / n,
    over2Fraction: over2 / n,
    voiDrawerNonBlankFraction: nonBlank / n,
    stockDrawerType: (a.viewer.drawer as unknown as { getType(): string }).getType(),
  };

  // 2. GPU W/L drag: uniforms only.
  const gpuMs: number[] = [];
  const uploadsBefore = drawerB.stats.uploads;
  for (const w of b.wins) {
    const t0 = performance.now();
    b.voi.setWindow(w);
    b.viewer.world.draw();
    drawerB.finish();
    gpuMs.push(performance.now() - t0);
  }
  out['gpuWindowLevel'] = {
    medianMs: median(gpuMs),
    uploadsDuringDrag: drawerB.stats.uploads - uploadsBefore,
  };

  // 3. CPU W/L through OSD 6's invalidation pipeline (async).
  const cpuMs: number[] = [];
  for (const w of a.wins.slice(0, 20)) {
    const t0 = performance.now();
    a.voi.setWindow(w);
    await (
      a.viewer as unknown as { requestInvalidate(restore: boolean): Promise<unknown> }
    ).requestInvalidate(true);
    a.viewer.world.draw();
    cpuMs.push(performance.now() - t0);
  }
  const probeCentre = (): number => {
    a.viewer.world.draw();
    return readPixels(a.viewer.drawer.canvas)[(256 * 512 + 256) * 4]!;
  };
  a.voi.setWindow({ center: -1000, width: 2 });
  await (
    a.viewer as unknown as { requestInvalidate(restore: boolean): Promise<unknown> }
  ).requestInvalidate(true);
  const white = probeCentre();
  out['cpuWindowLevelViaInvalidate'] = { medianMs: median(cpuMs), whiteAfterInvalidate: white };

  a.viewer.destroy();
  b.viewer.destroy();
  return out;
}

declare global {
  interface Window {
    __osd6?: { run: typeof run };
  }
}

window.__osd6 = { run };
document.documentElement.dataset['ready'] = 'true';
