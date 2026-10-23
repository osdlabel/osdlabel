/**
 * In-memory frame sources for the harness. Each one implements the
 * `FrameSource` contract from `@osdlabel/frame-osd` and tags the canvas it
 * paints with the frame index, which is how the recorder knows what OSD drew.
 */
import type { FrameSource } from '@osdlabel/frame-osd';
import { tagCanvas } from '../instrument/recorder.js';

/** 8-bit gray stack, expanded to RGBA through a 256-entry LUT on paint (where windowing would plug in). */
export class Gray8FrameStore implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  private readonly _data: Uint8Array;
  private readonly _image: ImageData;
  private readonly _u32: Uint32Array;
  private readonly _lut = new Uint32Array(256);
  /** Cumulative ms spent expanding + uploading (putImageData). */
  paintMs = 0;
  paints = 0;

  constructor(width: number, height: number, count: number, data: Uint8Array) {
    this.width = width;
    this.height = height;
    this.count = count;
    this._data = data;
    this._image = new ImageData(width, height);
    this._u32 = new Uint32Array(this._image.data.buffer);
    // Little-endian RGBA: 0xAABBGGRR.
    for (let g = 0; g < 256; g++) this._lut[g] = 0xff000000 | (g << 16) | (g << 8) | g;
  }

  paint(index: number, ctx: CanvasRenderingContext2D): boolean {
    const t0 = performance.now();
    const n = this.width * this.height;
    const off = index * n;
    const src = this._data;
    const dst = this._u32;
    const lut = this._lut;
    for (let i = 0; i < n; i++) dst[i] = lut[src[off + i]!]!;
    ctx.putImageData(this._image, 0, 0);
    tagCanvas(ctx.canvas, index);
    this.paintMs += performance.now() - t0;
    this.paints++;
    return true;
  }
}

/** Pre-decoded `ImageBitmap` per frame: paint is one `drawImage`. Costs width*height*4 bytes per frame. */
export class BitmapFrameStore implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  private readonly _bitmaps: readonly ImageBitmap[];
  paintMs = 0;
  paints = 0;

  constructor(width: number, height: number, bitmaps: readonly ImageBitmap[]) {
    this.width = width;
    this.height = height;
    this.count = bitmaps.length;
    this._bitmaps = bitmaps;
  }

  paint(index: number, ctx: CanvasRenderingContext2D): boolean {
    const bmp = this._bitmaps[index];
    if (!bmp) return false;
    const t0 = performance.now();
    ctx.drawImage(bmp, 0, 0);
    tagCanvas(ctx.canvas, index);
    this.paintMs += performance.now() - t0;
    this.paints++;
    return true;
  }

  close(): void {
    for (const b of this._bitmaps) b.close();
  }
}

/** RGBA frames held as raw pixels, uploaded with `putImageData` on paint. */
export class RgbaFrameStore implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  private readonly _frames: readonly ImageData[];
  paintMs = 0;
  paints = 0;

  constructor(width: number, height: number, frames: readonly ImageData[]) {
    this.width = width;
    this.height = height;
    this.count = frames.length;
    this._frames = frames;
  }

  paint(index: number, ctx: CanvasRenderingContext2D): boolean {
    const f = this._frames[index];
    if (!f) return false;
    const t0 = performance.now();
    ctx.putImageData(f, 0, 0);
    tagCanvas(ctx.canvas, index);
    this.paintMs += performance.now() - t0;
    this.paints++;
    return true;
  }
}

/** Build `ImageBitmap`s from an 8-bit gray stack (one-off cost, reported as setup). */
export async function grayStackToBitmaps(
  width: number,
  height: number,
  count: number,
  data: Uint8Array,
): Promise<ImageBitmap[]> {
  const img = new ImageData(width, height);
  const u32 = new Uint32Array(img.data.buffer);
  const n = width * height;
  const out: ImageBitmap[] = [];
  for (let f = 0; f < count; f++) {
    const off = f * n;
    for (let i = 0; i < n; i++) {
      const g = data[off + i]!;
      u32[i] = 0xff000000 | (g << 16) | (g << 8) | g;
    }
    out.push(await createImageBitmap(img));
  }
  return out;
}
