import { describe, it, expect } from 'vitest';
import type { MaskGeometry } from '@osdlabel/annotation';
import { area, boundingBox, centroid, length, perimeter, radius } from '../../src/index.js';

const mask: MaskGeometry = {
  type: 'mask',
  origin: { x: 100, y: 200 },
  width: 40,
  height: 20,
  pixelCount: 512,
};

describe('mask geometry math', () => {
  it('reports exact area from the painted pixel count, not the bounding box', () => {
    expect(area(mask)).toBe(512);
    expect(area(mask)).not.toBe(mask.width * mask.height);
  });

  it('returns the bounding box', () => {
    expect(boundingBox(mask)).toEqual({ min: { x: 100, y: 200 }, max: { x: 140, y: 220 } });
  });

  it('anchors at the centre of the bounding box', () => {
    expect(centroid(mask)).toEqual({ x: 120, y: 210 });
  });

  it('reports no perimeter or length, which would require tracing the contour', () => {
    expect(perimeter(mask)).toBe(0);
    expect(length(mask)).toBe(0);
  });

  it('has no radius', () => {
    expect(radius(mask)).toBeUndefined();
  });
});
