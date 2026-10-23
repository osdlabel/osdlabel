import type OpenSeadragon from 'openseadragon';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import type { VoiWindow } from '@osdlabel/pixel';
import { solveCssWindowEmulation } from '@osdlabel/pixel';
import { VoiWebGLDrawer } from '@osdlabel/osd-pixel';
import {
  createViewer,
  eightBitUrl,
  frames,
  getImage,
  host,
  openAndWait,
  openRasterViewer,
  waitFullyLoaded,
} from './common.js';

/**
 * H1 pixel-level check. The 64x64 value ramp (every HU from -1000 to +3000
 * once) is shown 8x magnified with nearest-neighbour sampling in a 512x512
 * viewer; the runner screenshots it and `decodeRamp` reads back the grey each
 * input value was displayed as.
 */
export type H1Path = 'gpu' | 'cpu' | 'css-osdlabel' | 'css-unbounded';

export const H1_SIZE = 512;
const BLOCK = 8;

let current: { viewer: OpenSeadragon.Viewer; overlay: FabricOverlay | null } | null = null;

function teardown(): void {
  current?.overlay?.destroy();
  current?.viewer.destroy();
  current = null;
}

export async function h1Setup(
  path: H1Path,
  window: VoiWindow,
): Promise<{ filter: string; brightness: number | null; contrast: number | null }> {
  teardown();
  const el = host('h1', H1_SIZE, H1_SIZE);
  const img = getImage('ramp');
  const noSmoothing = { imageSmoothingEnabled: false };

  if (path === 'gpu' || path === 'cpu') {
    const rv = await openRasterViewer(
      el,
      img,
      path === 'gpu' ? VoiWebGLDrawer : 'canvas',
      path === 'gpu' ? { format: 'r16i' } : undefined,
      64,
      noSmoothing,
    );
    rv.voi.setWindow(window);
    rv.viewer.forceRedraw();
    await frames(4);
    current = { viewer: rv.viewer, overlay: null };
    return { filter: '', brightness: null, contrast: null };
  }

  // The 8-bit path osdlabel has today: a full-range-quantised image, OSD's
  // default drawer, and tone applied as a CSS filter on the drawer canvas.
  const url = await eightBitUrl(img.full, img.range.min, img.range.max);
  const viewer = createViewer(el, undefined, noSmoothing);
  await openAndWait(viewer, { type: 'image', url, buildPyramid: false });
  await waitFullyLoaded(viewer);
  const overlay = new FabricOverlay(viewer);
  const drawerCanvas = viewer.drawer.canvas as HTMLElement;
  let brightness: number;
  let contrast: number;
  if (path === 'css-osdlabel') {
    // Through osdlabel's real API: exposure/contrast are clamped to [-1, 1].
    const e = solveCssWindowEmulation(window, img.range, 2);
    brightness = e.brightness;
    contrast = e.contrast;
    overlay.applyImageFilters({
      exposure: Math.max(-1, Math.min(1, brightness - 1)),
      contrast: Math.max(-1, Math.min(1, contrast - 1)),
      inverted: false,
    });
  } else {
    const e = solveCssWindowEmulation(window, img.range);
    brightness = e.brightness;
    contrast = e.contrast;
    drawerCanvas.style.filter = `brightness(${brightness}) contrast(${contrast})`;
  }
  viewer.forceRedraw();
  await frames(4);
  current = { viewer, overlay };
  return { filter: drawerCanvas.style.filter, brightness, contrast };
}

/** Decode a PNG screenshot of the 512x512 host and read each value's grey. */
export async function decodeRamp(pngBase64: string): Promise<number[]> {
  const bin = atob(pngBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no 2d');
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const img = getImage('ramp');
  const side = img.full.width;
  const count = img.range.max - img.range.min + 1;
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const x = (k % side) * BLOCK + BLOCK / 2;
    const y = Math.floor(k / side) * BLOCK + BLOCK / 2;
    out.push(px[(y * bmp.width + x) * 4]!);
  }
  teardown();
  return out;
}
