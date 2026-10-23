import { num } from '../dataset.js';
import type { Part10File } from '../part10-reader.js';
import { indexFrames, frameData } from '../frames.js';
import {
  applyWindow,
  deriveDisplayDefaults,
  type DefaultVoi,
  type DisplayDefaults,
} from '../mapping/display.js';
import { TAGS } from '../tags.js';

export interface RenderedFrame {
  readonly width: number;
  readonly height: number;
  /** RGBA, ready for `new ImageData(rgba, width, height)`. */
  readonly rgba: Uint8ClampedArray;
}

/**
 * Renders one frame of *native* (uncompressed) pixel data to 8-bit RGBA with
 * the modality's display defaults: Modality LUT (rescale), VOI (window or
 * LUT, with the VOI LUT Function) and polarity.
 *
 * A stand-in for the pixel pipeline, so the PoC can put real CT/MR/DX/US
 * pixels under osdlabel's annotator via an ordinary `{ type: 'image' }` tile
 * source. Re-windowing means re-rendering (CPU, one LUT pass) — exactly the
 * cost a GPU pixel pipeline would remove.
 */
export function renderNativeFrame(
  file: Part10File,
  frameIndex = 0,
  voi?: DefaultVoi,
  display: DisplayDefaults = deriveDisplayDefaults(file.dataset),
): RenderedFrame {
  const ds = file.dataset;
  const width = num(ds, TAGS.Columns.tag) ?? 0;
  const height = num(ds, TAGS.Rows.tag) ?? 0;
  const frames = indexFrames(file);
  const range = frames.frames[frameIndex];
  if (frames.method !== 'native' || !range)
    throw new Error('renderNativeFrame needs native pixel data');
  const bytes = frameData(file.source, range);
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  const pc = num(ds, TAGS.PlanarConfiguration.tag) ?? 0;

  if (display.samplesPerPixel === 3) {
    const ybr = display.photometric === 'YBR_FULL';
    for (let i = 0; i < n; i++) {
      let a: number, b: number, c: number;
      if (pc === 0) {
        a = bytes[i * 3]!;
        b = bytes[i * 3 + 1]!;
        c = bytes[i * 3 + 2]!;
      } else {
        a = bytes[i]!;
        b = bytes[n + i]!;
        c = bytes[2 * n + i]!;
      }
      if (ybr) {
        const y = a;
        const cb = b - 128;
        const cr = c - 128;
        a = y + 1.402 * cr;
        b = y - 0.344136 * cb - 0.714136 * cr;
        c = y + 1.772 * cb;
      }
      rgba[i * 4] = a;
      rgba[i * 4 + 1] = b;
      rgba[i * 4 + 2] = c;
      rgba[i * 4 + 3] = 255;
    }
    return { width, height, rgba };
  }

  // Monochrome: one LUT over every possible stored value.
  const bits = display.bitsAllocated;
  const stored = display.bitsStored;
  const signed = display.signed;
  const lo = signed ? -(2 ** (stored - 1)) : 0;
  const size = 2 ** stored;
  const lut = new Uint8Array(size);
  const chosen = voi ?? display.defaultVoi;
  for (let k = 0; k < size; k++) {
    const sv = lo + k;
    let mv: number;
    if (display.modalityLut) {
      const t = display.modalityLut;
      const idx = Math.min(Math.max(sv - t.firstMapped, 0), t.data.length - 1);
      mv = t.data[idx]!;
    } else mv = sv * display.rescale.slope + display.rescale.intercept;
    let y: number;
    if (chosen.kind === 'window') y = applyWindow(mv, chosen.window, display.voiFunction);
    else if (chosen.kind === 'lut') {
      const t = chosen.lut;
      const idx = Math.min(Math.max(Math.round(mv) - t.firstMapped, 0), t.data.length - 1);
      y = t.data[idx]! / (2 ** t.bitsPerEntry - 1);
    } else y = (mv - chosen.min) / (chosen.max - chosen.min || 1);
    y = Math.min(Math.max(y, 0), 1);
    if (display.invert) y = 1 - y;
    lut[k] = Math.round(y * 255);
  }
  const mask = size - 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    let raw = bits === 8 ? bytes[i]! : view.getUint16(i * 2, true);
    raw &= mask;
    // Sign-extend within Bits Stored, then shift into the LUT's index range.
    let sv = raw;
    if (signed && raw >= size / 2) sv = raw - size;
    const g = lut[sv - lo]!;
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }
  return { width, height, rgba };
}
