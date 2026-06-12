import { describe, expect, it } from 'vitest';
import type { CircleGeometry } from '@osdlabel/annotation';
import { boundingBox, circleToBoundingRectangle } from '../../src/index.js';

describe('circleToBoundingRectangle', () => {
  it('produces an axis-aligned rectangle spanning the circle diameter', () => {
    const circle: CircleGeometry = { type: 'circle', center: { x: 10, y: 20 }, radius: 5 };
    const rect = circleToBoundingRectangle(circle);
    expect(rect).toEqual({
      type: 'rectangle',
      origin: { x: 5, y: 15 },
      width: 10,
      height: 10,
      rotation: 0,
    });
  });

  it('matches the circle bounding box', () => {
    const circle: CircleGeometry = { type: 'circle', center: { x: -3, y: 7 }, radius: 12 };
    const rect = circleToBoundingRectangle(circle);
    const bbox = boundingBox(circle);
    expect(rect.origin).toEqual(bbox.min);
    expect(rect.width).toBe(bbox.max.x - bbox.min.x);
    expect(rect.height).toBe(bbox.max.y - bbox.min.y);
  });

  it('handles a zero-radius circle as a degenerate rectangle', () => {
    const circle: CircleGeometry = { type: 'circle', center: { x: 0, y: 0 }, radius: 0 };
    const rect = circleToBoundingRectangle(circle);
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });
});
