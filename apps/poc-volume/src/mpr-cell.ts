import OpenSeadragon from 'openseadragon';
import { DecorationLayer, FabricOverlay } from '@osdlabel/fabric-osd';
import { DEFAULT_VIEWER_OPTIONS } from '@osdlabel/osd-helper';
import { planeIndexMapping, type PlaneFrame, type VolumeGrid } from '@osdlabel/spatial';
import { applyWindowLut, reslice, type ScalarVolume } from '@osdlabel/volume';
import { createCanvasTileSource, drawNow, invalidateTile } from './canvas-tile-source.js';
import type { GlReslicer } from './gl-reslicer.js';
import type { PlaneKind } from './planes.js';
import type { ReslicePool } from './reslice-pool.js';

export type Drawer = 'canvas' | 'webgl';
export type ResliceMethod = 'cpu' | 'workers' | 'gl';

/**
 * One osdlabel cell showing one plane of a volume: a stock OSD viewer +
 * FabricOverlay + DecorationLayer (exactly what ViewerCell builds), whose
 * image is a canvas the reslicer writes into.
 */
export interface MprCell {
  readonly key: PlaneKind;
  frame: PlaneFrame;
  readonly viewer: OpenSeadragon.Viewer;
  readonly overlay: FabricOverlay;
  readonly layer: DecorationLayer;
  readonly tile: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly image: ImageData;
  readonly rgba: Uint32Array;
  /** Reslice output in HU, shared so workers can write it. */
  readonly hu: Int16Array;
  readonly huBuffer: SharedArrayBuffer;
}

export async function createCell(
  key: PlaneKind,
  frame: PlaneFrame,
  element: HTMLElement,
  drawer: Drawer,
): Promise<MprCell> {
  const tile = document.createElement('canvas');
  tile.width = frame.width;
  tile.height = frame.height;
  const ctx = tile.getContext('2d')!;
  const viewer = OpenSeadragon({
    ...DEFAULT_VIEWER_OPTIONS,
    element,
    drawer,
    animationTime: 0,
    immediateRender: true,
  });
  const opened = new Promise<void>((resolve, reject) => {
    viewer.addOnceHandler('open', () => resolve());
    viewer.addOnceHandler('open-failed', (e) => reject(new Error(String(e.message))));
  });
  viewer.open(createCanvasTileSource(tile, ctx));
  await opened;
  // Wait for the single tile to be "loaded" (it is synchronous, but OSD
  // schedules it on its update loop).
  for (let i = 0; i < 200; i++) {
    const item = viewer.world.getItemAt(0);
    if (item && item.getFullyLoaded()) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
  const overlay = new FabricOverlay(viewer);
  const layer = new DecorationLayer(overlay);
  const huBuffer = new SharedArrayBuffer(frame.width * frame.height * 2);
  const image = new ImageData(frame.width, frame.height);
  return {
    key,
    frame,
    viewer,
    overlay,
    layer,
    tile,
    ctx,
    image,
    rgba: new Uint32Array(image.data.buffer),
    hu: new Int16Array(huBuffer),
    huBuffer,
  };
}

export interface PhaseTimes {
  reslice: number;
  upload: number;
  osdDraw: number;
}

/**
 * Reslice the cell's current plane and redraw its image. Every phase is
 * synchronous except the worker reslice, which is awaited.
 */
export async function renderPlane(
  cell: MprCell,
  volume: ScalarVolume,
  method: ResliceMethod,
  lut: Uint32Array,
  window: { readonly center: number; readonly width: number },
  helpers: { readonly pool?: ReslicePool | undefined; readonly gl?: GlReslicer | undefined },
): Promise<PhaseTimes> {
  const grid: VolumeGrid = volume.grid;
  const f = cell.frame;
  const m = planeIndexMapping(grid, f);
  const t0 = performance.now();
  if (method === 'gl') {
    const gl = helpers.gl;
    if (!gl) throw new Error('no GL reslicer');
    gl.render(m, f.width, f.height, window.center, window.width, true);
  } else if (method === 'workers') {
    if (!helpers.pool) throw new Error('no worker pool');
    await helpers.pool.run(m, f.width, f.height, cell.huBuffer, 'linear');
  } else {
    reslice(volume, m, f.width, f.height, cell.hu);
  }
  const t1 = performance.now();
  if (method === 'gl') {
    const gl = helpers.gl!;
    cell.ctx.drawImage(gl.canvas, 0, 0, f.width, f.height, 0, 0, f.width, f.height);
  } else {
    applyWindowLut(cell.hu, lut, cell.rgba);
    cell.ctx.putImageData(cell.image, 0, 0);
  }
  invalidateTile(cell.viewer, cell.tile);
  const t2 = performance.now();
  drawNow(cell.viewer);
  const t3 = performance.now();
  return { reslice: t1 - t0, upload: t2 - t1, osdDraw: t3 - t2 };
}
