import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config as fabricConfig } from 'fabric';
import {
  observeDevicePixelRatio,
  resolveDevicePixelRatioChange,
  syncFabricDevicePixelRatio,
} from '../../../src/overlay/device-pixel-ratio.js';

describe('resolveDevicePixelRatioChange', () => {
  it('returns the new ratio when it differs', () => {
    expect(resolveDevicePixelRatioChange(1, 2)).toBe(2);
    expect(resolveDevicePixelRatioChange(2, 1)).toBe(1);
  });

  it('returns null when the ratio is unchanged', () => {
    expect(resolveDevicePixelRatioChange(2, 2)).toBeNull();
  });

  it('preserves fractional ratios', () => {
    // Windows display scaling produces ratios like 1.25 / 1.5 / 1.7647.
    expect(resolveDevicePixelRatioChange(1, 1.7647058823529411)).toBe(1.7647058823529411);
  });

  it('rejects ratios that would collapse or poison the backing store', () => {
    // A zero or negative scale collapses the canvas; NaN propagates into every
    // later dimension calculation.
    expect(resolveDevicePixelRatioChange(1, 0)).toBeNull();
    expect(resolveDevicePixelRatioChange(1, -2)).toBeNull();
    expect(resolveDevicePixelRatioChange(1, Number.NaN)).toBeNull();
    expect(resolveDevicePixelRatioChange(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('syncFabricDevicePixelRatio', () => {
  // Fabric's `config` is a process-global singleton shared by every test file
  // in this worker, so it must be restored.
  let originalRatio: number;

  beforeEach(() => {
    originalRatio = fabricConfig.devicePixelRatio;
  });

  afterEach(() => {
    fabricConfig.devicePixelRatio = originalRatio;
  });

  it('writes the new ratio and reports the change', () => {
    fabricConfig.devicePixelRatio = 1;
    expect(syncFabricDevicePixelRatio(3)).toBe(true);
    expect(fabricConfig.devicePixelRatio).toBe(3);
  });

  it('leaves the config untouched when nothing changed', () => {
    fabricConfig.devicePixelRatio = 2;
    expect(syncFabricDevicePixelRatio(2)).toBe(false);
    expect(fabricConfig.devicePixelRatio).toBe(2);
  });

  it('leaves the config untouched for an unusable ratio', () => {
    fabricConfig.devicePixelRatio = 2;
    expect(syncFabricDevicePixelRatio(0)).toBe(false);
    expect(fabricConfig.devicePixelRatio).toBe(2);
  });
});

describe('observeDevicePixelRatio', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    if (originalMatchMedia === undefined) {
      delete (window as unknown as Record<string, unknown>).matchMedia;
    } else {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('no-ops when matchMedia is unavailable', () => {
    delete (window as unknown as Record<string, unknown>).matchMedia;
    const onChange = vi.fn();
    const dispose = observeDevicePixelRatio(onChange);
    expect(onChange).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('watches the current ratio and re-arms after each change', () => {
    const listeners: (() => void)[] = [];
    const queries: string[] = [];
    window.matchMedia = vi.fn((query: string) => {
      queries.push(query);
      return {
        addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
        removeEventListener: vi.fn(),
      } as unknown as MediaQueryList;
    });

    const onChange = vi.fn();
    const dispose = observeDevicePixelRatio(onChange);

    expect(queries).toEqual([`(resolution: ${window.devicePixelRatio}dppx)`]);

    listeners[0]?.();

    // Re-armed with a fresh query, and the caller was notified.
    expect(queries).toHaveLength(2);
    expect(onChange).toHaveBeenCalledWith(window.devicePixelRatio);

    dispose();
  });

  it('stops notifying after dispose', () => {
    const listeners: (() => void)[] = [];
    window.matchMedia = vi.fn(
      () =>
        ({
          addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    const onChange = vi.fn();
    const dispose = observeDevicePixelRatio(onChange);
    dispose();
    listeners[0]?.();

    expect(onChange).not.toHaveBeenCalled();
  });
});
