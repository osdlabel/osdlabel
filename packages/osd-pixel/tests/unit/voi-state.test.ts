import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_RESCALE } from '@osdlabel/pixel';
import { VoiState } from '../../src/voi-state.js';

describe('VoiState', () => {
  const make = (): VoiState =>
    new VoiState(
      { min: -1000, max: 3000 },
      { rescale: IDENTITY_RESCALE, window: { center: 40, width: 80 }, invert: false },
    );

  it('bumps the version and notifies on every change', () => {
    const s = make();
    const l = vi.fn();
    s.onChange(l);
    s.setWindow({ center: 50, width: 400 });
    s.setInvert(true);
    expect(s.version).toBe(2);
    expect(l).toHaveBeenCalledTimes(2);
    expect(s.transform.window.center).toBe(50);
    expect(s.transform.invert).toBe(true);
  });

  it('builds the LUT once per version', () => {
    const s = make();
    const a = s.lut();
    expect(s.lut()).toBe(a);
    s.setWindow({ center: 0, width: 100 });
    expect(s.lut()).not.toBe(a);
    expect(s.lut().gray.length).toBe(4001);
  });
});
