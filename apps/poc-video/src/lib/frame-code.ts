/**
 * Reader for the frame-index barcode `scripts/gen-videos.py` burns into every
 * frame: two bands of 16 blocks at the top of the image, the second the
 * inverse of the first.
 *
 * The harness draws the two bands (image rows `[0, 2 * bandH)`) scaled into a
 * small RGBA buffer `bits * cellW` wide and `2 * cellH` tall, and hands it
 * here. Each block is judged on the mean luma of its central half, so scaling
 * blur and compression ringing at block edges do not matter.
 */
export interface FrameCodeSample {
  /** RGBA, row-major, `width * height * 4` bytes. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface FrameCodeResult {
  /** The decoded index, or -1 when the parity band disagrees. */
  readonly value: number;
  /** Smallest contrast between a block and its inverse, 0-255. */
  readonly margin: number;
}

function meanLuma(s: FrameCodeSample, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * s.width + x) * 4;
      sum += 0.299 * s.data[o]! + 0.587 * s.data[o + 1]! + 0.114 * s.data[o + 2]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

export function readFrameCode(s: FrameCodeSample, bits = 16, minMargin = 64): FrameCodeResult {
  const cellW = s.width / bits;
  const bandH = s.height / 2;
  let value = 0;
  let margin = 255;
  for (let k = 0; k < bits; k++) {
    const x0 = Math.floor(k * cellW + cellW / 4);
    const x1 = Math.max(x0 + 1, Math.floor(k * cellW + (3 * cellW) / 4));
    const y0 = Math.floor(bandH / 4);
    const y1 = Math.max(y0 + 1, Math.floor((3 * bandH) / 4));
    const a = meanLuma(s, x0, x1, y0, y1);
    const b = meanLuma(s, x0, x1, y0 + Math.floor(bandH), y1 + Math.floor(bandH));
    margin = Math.min(margin, Math.abs(a - b));
    value = (value << 1) | (a > b ? 1 : 0);
  }
  return { value: margin >= minMargin ? value : -1, margin };
}

/** Encode `value` the way the generator does, into a buffer {@link readFrameCode} accepts. */
export function writeFrameCode(value: number, bits = 16, cellW = 8, cellH = 8): FrameCodeSample {
  const width = bits * cellW;
  const height = 2 * cellH;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = Math.floor(x / cellW);
      const bit = (value >> (bits - 1 - k)) & 1;
      const on = y < cellH ? bit === 1 : bit === 0;
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = on ? 255 : 0;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}
