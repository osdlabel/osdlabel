import { describe, expect, it } from 'vitest';
import {
  bandingStats,
  compareWindowPaths,
  cssBrightnessThenContrast8,
  dequantize8,
  quantize8,
  solveCssWindowEmulation,
} from '../../src/banding.js';
import { applyVoi, CT_WINDOW_PRESETS } from '../../src/voi.js';

const CT = { min: -1000, max: 3000 } as const;

describe('quantisation', () => {
  it('maps the full range onto 0..255', () => {
    expect(quantize8(-1000, CT)).toBe(0);
    expect(quantize8(3000, CT)).toBe(255);
    expect(dequantize8(255, CT)).toBe(3000);
  });
});

describe('cssBrightnessThenContrast8', () => {
  it('is the identity at b=c=1', () => {
    for (const v of [0, 1, 127, 128, 255]) expect(cssBrightnessThenContrast8(v, 1, 1)).toBe(v);
  });
  it('clamps after brightness', () => {
    expect(cssBrightnessThenContrast8(200, 2, 1)).toBe(255);
  });
});

describe('solveCssWindowEmulation', () => {
  it('is exact for the brain window with unbounded factors', () => {
    const e = solveCssWindowEmulation(CT_WINDOW_PRESETS.brain, CT);
    expect(e.exact).toBe(true);
    expect(e.achievedSlope).toBeCloseTo(50, 10);
  });

  it("cannot reach the brain window within osdlabel's [0, 2] bounds", () => {
    const e = solveCssWindowEmulation(CT_WINDOW_PRESETS.brain, CT, 2);
    expect(e.exact).toBe(false);
    expect(e.achievedSlope).toBeLessThanOrEqual(4);
  });

  it('flags the lung window, where brightness clips before contrast', () => {
    expect(solveCssWindowEmulation(CT_WINDOW_PRESETS.lung, CT).exact).toBe(false);
  });
});

describe('bandingStats', () => {
  it('counts levels, steps and band widths', () => {
    const w = { center: 5, width: 10 };
    const s = bandingStats(w, { min: 0, max: 100 }, (v) => (v < 5 ? 0 : 200));
    expect(s.distinctLevels).toBe(2);
    expect(s.maxStep).toBe(200);
    expect(s.inputValues).toBe(11);
  });

  it('a correct brain window shows every HU value as its own level', () => {
    const w = CT_WINDOW_PRESETS.brain;
    const s = bandingStats(w, CT, (v) => Math.round(applyVoi(v, w, 0, 255)));
    expect(s.distinctLevels).toBe(s.inputValues - 1); // both ends clip to 0 / 255
    expect(s.maxBandWidth).toBe(2);
  });
});

describe('compareWindowPaths', () => {
  it('8-bit pre-quantisation collapses the brain window to a handful of levels', () => {
    const c = compareWindowPaths(CT_WINDOW_PRESETS.brain, CT);
    // 80 HU / (4000/255 HU per 8-bit step) ~ 5 steps
    expect(c.best8bit.distinctLevels).toBeLessThanOrEqual(7);
    expect(c.unboundedCss.distinctLevels).toBeLessThanOrEqual(c.best8bit.distinctLevels + 1);
    expect(c.correct.distinctLevels).toBeGreaterThan(70);
    expect(c.best8bit.maxStep).toBeGreaterThan(40);
  });
});
