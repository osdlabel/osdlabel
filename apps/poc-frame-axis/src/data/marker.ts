/**
 * A frame-index barcode stamped into every synthetic frame, so a pixel
 * readback of what a renderer *actually* displayed can be decoded back to a
 * frame index. A tag on the tile canvas only says what OSD meant to draw; a
 * stale GPU texture would still be reported as the new frame. The barcode
 * cannot lie that way.
 *
 * Layout: a white guard block, then 12 bit blocks, each BLOCK px square,
 * starting at (ORIGIN, ORIGIN). Bit set = 255, clear = 0.
 */
export const MARKER_BITS = 12;
export const MARKER_BLOCK = 8;
export const MARKER_ORIGIN = 8;

/** Image-space centre of block `i` (0 = guard, 1..MARKER_BITS = bits, LSB first). */
export function markerBlockCenter(i: number): { x: number; y: number } {
  return {
    x: MARKER_ORIGIN + i * MARKER_BLOCK + MARKER_BLOCK / 2,
    y: MARKER_ORIGIN + MARKER_BLOCK / 2,
  };
}

/**
 * Stamp `index` into an 8-bit buffer with `channels` interleaved channels
 * (1 = gray, 3 = RGB, 4 = RGBA; alpha is left alone).
 */
export function stampFrameMarker(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  channels: 1 | 3 | 4,
  index: number,
): void {
  const colorChannels = channels === 4 ? 3 : channels;
  for (let block = 0; block <= MARKER_BITS; block++) {
    const on = block === 0 ? true : ((index >> (block - 1)) & 1) === 1;
    const v = on ? 255 : 0;
    const x0 = MARKER_ORIGIN + block * MARKER_BLOCK;
    for (let y = MARKER_ORIGIN; y < MARKER_ORIGIN + MARKER_BLOCK; y++) {
      for (let x = x0; x < x0 + MARKER_BLOCK; x++) {
        const p = (y * width + x) * channels;
        for (let c = 0; c < colorChannels; c++) data[p + c] = v;
      }
    }
  }
}

/**
 * Decode a frame index from sampled block intensities (guard first). Returns
 * -1 when the guard is not bright (the marker is not on screen or the frame
 * is blank).
 */
export function decodeFrameMarker(samples: readonly number[]): number {
  if ((samples[0] ?? 0) < 128) return -1;
  let index = 0;
  for (let bit = 0; bit < MARKER_BITS; bit++) {
    if ((samples[bit + 1] ?? 0) >= 128) index |= 1 << bit;
  }
  return index;
}
