import { describe, it, expect } from 'vitest';
import { rectangleCenter, rectangleOrigin } from '../../src/rectangle-anchor.js';

describe('rectangleCenter', () => {
  it('is the origin plus half the size', () => {
    expect(rectangleCenter({ x: 10, y: 20 }, 100, 50)).toEqual({ x: 60, y: 45 });
  });
});

describe('rectangleOrigin', () => {
  it('inverts rectangleCenter', () => {
    const origin = { x: 12.5, y: -7 };
    expect(rectangleOrigin(rectangleCenter(origin, 80, 30), 80, 30)).toEqual(origin);
  });
});
