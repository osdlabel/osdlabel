import { describe, expect, it } from 'vitest';
import {
  applyRescale,
  applyVoi,
  CT_WINDOW_PRESETS,
  voiLinear,
  voiLinearExact,
  voiSigmoid,
} from '../../src/voi.js';

describe('voiLinear (DICOM C.11.2.1.2.1)', () => {
  it('clamps below and above the window', () => {
    expect(voiLinear(-1000, 40, 80, 0, 255)).toBe(0);
    expect(voiLinear(1000, 40, 80, 0, 255)).toBe(255);
  });

  it('uses the -0.5 / (w-1) edge convention', () => {
    // c=40, w=80: lo = 40 - 0.5 - 39.5 = 0, hi = 79
    expect(voiLinear(0, 40, 80, 0, 255)).toBe(0); // x <= lo -> ymin
    expect(voiLinear(79, 40, 80, 0, 255)).toBeCloseTo(255, 10); // the top edge maps to ymax exactly
    expect(voiLinear(79.0001, 40, 80, 0, 255)).toBe(255);
    expect(voiLinear(39.5, 40, 80, 0, 255)).toBeCloseTo(127.5, 10);
  });

  it('treats width 1 as a threshold', () => {
    expect(voiLinear(99, 100, 1, 0, 255)).toBe(0);
    expect(voiLinear(100, 100, 1, 0, 255)).toBe(255);
  });
});

describe('other VOI functions', () => {
  it('LINEAR_EXACT has no half-pixel shift', () => {
    expect(voiLinearExact(40, 40, 80, 0, 255)).toBeCloseTo(127.5, 10);
    expect(voiLinearExact(0, 40, 80, 0, 255)).toBe(0);
    expect(voiLinearExact(80, 40, 80, 0, 255)).toBe(255);
  });

  it('SIGMOID is centred and monotonic', () => {
    expect(voiSigmoid(40, 40, 80, 0, 255)).toBeCloseTo(127.5, 10);
    expect(voiSigmoid(0, 40, 80, 0, 255)).toBeLessThan(voiSigmoid(80, 40, 80, 0, 255));
  });

  it('applyVoi dispatches on fn and defaults to LINEAR', () => {
    const w = CT_WINDOW_PRESETS.brain;
    expect(applyVoi(39.5, w)).toBeCloseTo(127.5, 10);
    expect(applyVoi(40, { ...w, fn: 'LINEAR_EXACT' })).toBeCloseTo(127.5, 10);
  });

  it('applyRescale maps stored values to modality units', () => {
    expect(applyRescale(0, { slope: 1, intercept: -1024 })).toBe(-1024);
    expect(applyRescale(1064, { slope: 1, intercept: -1024 })).toBe(40);
  });
});
