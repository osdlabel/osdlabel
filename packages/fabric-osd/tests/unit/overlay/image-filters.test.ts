import { describe, it, expect } from 'vitest';
import { composeImageFilterCss } from '../../../src/overlay/image-filters.js';

describe('composeImageFilterCss', () => {
  it('returns an empty string when nothing is adjusted', () => {
    expect(composeImageFilterCss({ exposure: 0, contrast: 0, inverted: false })).toBe('');
  });

  it('maps exposure onto brightness()', () => {
    expect(composeImageFilterCss({ exposure: 0.1, contrast: 0, inverted: false })).toBe(
      'brightness(1.1)',
    );
    expect(composeImageFilterCss({ exposure: -1, contrast: 0, inverted: false })).toBe(
      'brightness(0)',
    );
    expect(composeImageFilterCss({ exposure: 1, contrast: 0, inverted: false })).toBe(
      'brightness(2)',
    );
  });

  it('maps contrast onto contrast()', () => {
    expect(composeImageFilterCss({ exposure: 0, contrast: 0.1, inverted: false })).toBe(
      'contrast(1.1)',
    );
    expect(composeImageFilterCss({ exposure: 0, contrast: -1, inverted: false })).toBe(
      'contrast(0)',
    );
    expect(composeImageFilterCss({ exposure: 0, contrast: 1, inverted: false })).toBe(
      'contrast(2)',
    );
  });

  it('emits brightness, then contrast, then invert', () => {
    expect(composeImageFilterCss({ exposure: 0.2, contrast: -0.5, inverted: true })).toBe(
      'brightness(1.2) contrast(0.5) invert(1)',
    );
  });

  it('omits the neutral adjustments rather than emitting identity filters', () => {
    expect(composeImageFilterCss({ exposure: 0, contrast: 0.4, inverted: true })).toBe(
      'contrast(1.4) invert(1)',
    );
    expect(composeImageFilterCss({ exposure: 0, contrast: 0, inverted: true })).toBe('invert(1)');
  });
});
