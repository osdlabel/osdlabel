import { describe, expect, it } from 'vitest';
import { readFrameCode, writeFrameCode } from '../../src/lib/frame-code.js';

describe('frame code', () => {
  it('round-trips every value and rejects a blended frame', () => {
    for (const v of [0, 1, 2, 29, 30, 255, 256, 299, 65535]) {
      expect(readFrameCode(writeFrameCode(v)).value).toBe(v);
    }
    // 50/50 blend of two frames (what a decoder never shows, a scaler might).
    const a = writeFrameCode(5);
    const b = writeFrameCode(6);
    const mix = new Uint8ClampedArray(a.data.length);
    for (let i = 0; i < mix.length; i++) mix[i] = (a.data[i]! + b.data[i]!) / 2;
    expect(readFrameCode({ ...a, data: mix }).value).toBe(-1);
  });
});
