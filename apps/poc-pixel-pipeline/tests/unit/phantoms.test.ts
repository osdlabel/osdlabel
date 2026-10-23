import { describe, expect, it } from 'vitest';
import { measureRange } from '@osdlabel/pixel';
import {
  ctHeadPhantom,
  mammoPhantom,
  mulberry32,
  quantizeToRgba8,
  valueRamp,
} from '../../src/data/phantoms.js';

describe('ctHeadPhantom', () => {
  const p = ctHeadPhantom(128);

  it('spans exactly -1000..3000 HU in an Int16Array', () => {
    expect(p.data).toBeInstanceOf(Int16Array);
    expect(measureRange(p.data)).toEqual({ min: -1000, max: 3000 });
  });

  it('is deterministic', () => {
    expect(ctHeadPhantom(128).data).toEqual(p.data);
  });

  it('has soft tissue a few HU apart (what the brain window must resolve)', () => {
    const centre = p.data[64 * 128 + 64]!;
    expect(centre).toBeGreaterThan(10);
    expect(centre).toBeLessThan(60);
  });
});

describe('valueRamp', () => {
  it('holds every value of the range once, then clamps', () => {
    const r = valueRamp(-1000, 3000);
    expect(r.width).toBe(64);
    expect(r.data[0]).toBe(-1000);
    expect(r.data[4000]).toBe(3000);
    expect(r.data[4095]).toBe(3000);
    expect(new Set(r.data).size).toBe(4001);
  });
});

describe('mammoPhantom', () => {
  it('is 16-bit with a wide dynamic range', () => {
    const m = mammoPhantom(512, 416);
    expect(m.data).toBeInstanceOf(Uint16Array);
    const range = measureRange(m.data);
    expect(range.max - range.min).toBeGreaterThan(30000);
  });
});

describe('helpers', () => {
  it('mulberry32 is seeded', () => {
    expect(mulberry32(3)()).toBe(mulberry32(3)());
  });

  it('quantizeToRgba8 maps the range onto 0..255 grey', () => {
    const q = quantizeToRgba8(
      { width: 2, height: 1, data: new Int16Array([-1000, 3000]) },
      -1000,
      3000,
    );
    expect([...q]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});
