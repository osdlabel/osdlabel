import { describe, expect, it } from 'vitest';
import {
  applyVoiDirectRgba32,
  applyVoiLutBytes,
  applyVoiLutRgba32,
  buildVoiLut,
  displayValue,
  packGray,
} from '../../src/voi-lut.js';
import type { DisplayTransform } from '../../src/voi-lut.js';
import { IDENTITY_RESCALE } from '../../src/voi.js';

const brain: DisplayTransform = {
  rescale: IDENTITY_RESCALE,
  window: { center: 40, width: 80 },
  invert: false,
};

describe('buildVoiLut', () => {
  it('covers the range and matches displayValue', () => {
    const lut = buildVoiLut({ min: -1000, max: 3000 }, brain);
    expect(lut.gray.length).toBe(4001);
    for (const v of [-1000, 0, 20, 40, 79, 3000]) {
      expect(lut.gray[v + 1000]).toBe(displayValue(v, brain));
      expect(lut.rgba32[v + 1000]).toBe(packGray(displayValue(v, brain)));
    }
  });

  it('honours invert', () => {
    const lut = buildVoiLut({ min: 0, max: 100 }, { ...brain, invert: true });
    expect(lut.gray[0]).toBe(255);
    expect(lut.gray[100]).toBe(0);
  });
});

describe('applying the LUT', () => {
  const src = new Int16Array([-1000, 0, 20, 40, 60, 79, 3000, -2000, 4000]);
  const lut = buildVoiLut({ min: -1000, max: 3000 }, brain);

  it('packed and byte paths agree, and clamp out-of-range values', () => {
    const packed = new Uint8ClampedArray(src.length * 4);
    applyVoiLutRgba32(src, lut, new Uint32Array(packed.buffer));
    const bytes = new Uint8ClampedArray(src.length * 4);
    applyVoiLutBytes(src, lut, bytes);
    expect([...packed]).toEqual([...bytes]);
    // -2000 clamps to the LUT's first entry, 4000 to its last
    expect(bytes[7 * 4]).toBe(lut.gray[0]);
    expect(bytes[8 * 4]).toBe(lut.gray[4000]);
    expect(bytes[3]).toBe(255);
  });

  it('the direct per-pixel path agrees with the LUT for in-range values', () => {
    const inRange = src.subarray(0, 7);
    const a = new Uint32Array(inRange.length);
    const b = new Uint32Array(inRange.length);
    applyVoiLutRgba32(inRange, lut, a);
    applyVoiDirectRgba32(inRange, brain, b);
    expect([...a]).toEqual([...b]);
  });

  it('respects start/end so workers can split a buffer', () => {
    const dst = new Uint32Array(src.length);
    applyVoiLutRgba32(src, lut, dst, 2, 4);
    expect(dst[0]).toBe(0);
    expect(dst[2]).toBe(lut.rgba32[1020]);
    expect(dst[4]).toBe(0);
  });
});
