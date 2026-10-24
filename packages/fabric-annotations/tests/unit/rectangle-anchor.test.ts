import { describe, it, expect } from 'vitest';
import { rectangleCenter, rectangleOrigin } from '../../src/rectangle-anchor.js';

describe('rectangleCenter', () => {
  it('is the origin plus half the size when unrotated', () => {
    expect(rectangleCenter({ x: 10, y: 20 }, 100, 50, 0)).toEqual({ x: 60, y: 45 });
  });

  it('rotates the half-size offset about the origin corner', () => {
    const center = rectangleCenter({ x: 0, y: 0 }, 100, 50, 90);
    expect(center.x).toBeCloseTo(-25);
    expect(center.y).toBeCloseTo(50);
  });
});

describe('rectangleOrigin', () => {
  it.each([0, 30, 90, 180, -45])('inverts rectangleCenter at %d°', (rotation) => {
    const origin = { x: 12.5, y: -7 };
    const back = rectangleOrigin(rectangleCenter(origin, 80, 30, rotation), 80, 30, rotation);
    expect(back.x).toBeCloseTo(origin.x);
    expect(back.y).toBeCloseTo(origin.y);
  });
});
