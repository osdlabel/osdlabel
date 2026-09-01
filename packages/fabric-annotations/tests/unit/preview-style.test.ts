import { describe, it, expect } from 'vitest';
import { DEFAULT_ANNOTATION_STYLE, type AnnotationStyle } from '@osdlabel/annotation';
import { getPreviewOptions, DEFAULT_PREVIEW_DASH_SCREEN_PX } from '../../src/preview-style.js';

describe('getPreviewOptions', () => {
  it('takes stroke colour, width and opacity from the resolved style', () => {
    const style: AnnotationStyle = {
      ...DEFAULT_ANNOTATION_STYLE,
      strokeColor: '#00e5ff',
      strokeWidth: 3,
      opacity: 0.8,
    };

    const options = getPreviewOptions(style, 1);

    expect(options.stroke).toBe('#00e5ff');
    expect(options.strokeWidth).toBe(3);
    expect(options.opacity).toBe(0.8);
  });

  it('keeps the stroke width constant in screen pixels', () => {
    const style: AnnotationStyle = { ...DEFAULT_ANNOTATION_STYLE, strokeWidth: 2 };

    // An image wider than its viewport (the whole-slide / radiograph case)
    // renders at zoom < 1; an image-space width would collapse to a hairline.
    expect(getPreviewOptions(style, 0.1).strokeWidth).toBeCloseTo(20);
    expect(getPreviewOptions(style, 4).strokeWidth).toBeCloseTo(0.5);
  });

  it('leaves the preview unfilled and non-interactive', () => {
    const options = getPreviewOptions(DEFAULT_ANNOTATION_STYLE, 1);

    expect(options.fill).toBe('transparent');
    expect(options.selectable).toBe(false);
    expect(options.evented).toBe(false);
    expect(options.objectCaching).toBe(false);
  });

  it('keeps the default dash constant in screen pixels', () => {
    expect(getPreviewOptions(DEFAULT_ANNOTATION_STYLE, 1).strokeDashArray).toEqual([
      DEFAULT_PREVIEW_DASH_SCREEN_PX,
      DEFAULT_PREVIEW_DASH_SCREEN_PX,
    ]);
    expect(getPreviewOptions(DEFAULT_ANNOTATION_STYLE, 5).strokeDashArray).toEqual([1, 1]);
  });

  it('prefers an explicit strokeDashArray from the style', () => {
    const style: AnnotationStyle = { ...DEFAULT_ANNOTATION_STYLE, strokeDashArray: [2, 8] };

    expect(getPreviewOptions(style, 1).strokeDashArray).toEqual([2, 8]);
    // …also converted to image space, so the pattern holds its screen rhythm.
    expect(getPreviewOptions(style, 4).strokeDashArray).toEqual([0.5, 2]);
  });

  it('copies the style dash array rather than aliasing it', () => {
    const dash = [2, 8];
    const style: AnnotationStyle = { ...DEFAULT_ANNOTATION_STYLE, strokeDashArray: dash };

    const options = getPreviewOptions(style, 1);
    options.strokeDashArray[0] = 99;

    expect(dash[0]).toBe(2);
  });

  it('falls back to zoom 1 for a non-positive or non-finite zoom', () => {
    for (const zoom of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getPreviewOptions(DEFAULT_ANNOTATION_STYLE, zoom).strokeDashArray).toEqual([
        DEFAULT_PREVIEW_DASH_SCREEN_PX,
        DEFAULT_PREVIEW_DASH_SCREEN_PX,
      ]);
    }
  });
});
