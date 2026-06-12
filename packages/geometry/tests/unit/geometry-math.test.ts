import { describe, expect, it } from 'vitest';
import type { Geometry } from '@osdlabel/annotation';
import {
  area,
  boundingBox,
  centroid,
  distance,
  length,
  midpoint,
  perimeter,
  radius,
} from '../../src/geometry-math.js';

describe('distance', () => {
  it('returns the Euclidean distance between two points', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
  it('is symmetric', () => {
    expect(distance({ x: 2, y: 7 }, { x: -1, y: 3 })).toBeCloseTo(
      distance({ x: -1, y: 3 }, { x: 2, y: 7 }),
    );
  });
});

describe('midpoint', () => {
  it('returns the average of the two points', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 8 })).toEqual({ x: 2, y: 4 });
  });
});

describe('area', () => {
  it('rectangle: width × height', () => {
    const g: Geometry = {
      type: 'rectangle',
      origin: { x: 5, y: 5 },
      width: 10,
      height: 4,
      rotation: 0,
    };
    expect(area(g)).toBe(40);
  });
  it('rectangle: rotation does not change area', () => {
    const a: Geometry = {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 10,
      height: 4,
      rotation: 0,
    };
    const b: Geometry = {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 10,
      height: 4,
      rotation: 37,
    };
    expect(area(a)).toBe(area(b));
  });
  it('circle: π·r²', () => {
    const g: Geometry = { type: 'circle', center: { x: 0, y: 0 }, radius: 5 };
    expect(area(g)).toBeCloseTo(Math.PI * 25);
  });
  it('polygon: shoelace area (square)', () => {
    const g: Geometry = {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
    };
    expect(area(g)).toBe(16);
  });
  it('polygon: shoelace area is winding-independent', () => {
    const ccw: Geometry = {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
    };
    const cw: Geometry = {
      type: 'polygon',
      points: [...ccw.points].reverse(),
    };
    expect(area(cw)).toBe(area(ccw));
  });
  it('line / point / polyline area is 0', () => {
    expect(area({ type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 4 } })).toBe(0);
    expect(area({ type: 'point', position: { x: 1, y: 2 } })).toBe(0);
    expect(
      area({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    ).toBe(0);
  });
});

describe('perimeter', () => {
  it('rectangle: 2·(w + h)', () => {
    expect(
      perimeter({ type: 'rectangle', origin: { x: 0, y: 0 }, width: 3, height: 7, rotation: 0 }),
    ).toBe(20);
  });
  it('circle: 2·π·r', () => {
    expect(perimeter({ type: 'circle', center: { x: 0, y: 0 }, radius: 5 })).toBeCloseTo(
      2 * Math.PI * 5,
    );
  });
  it('polygon: sum of edge lengths (including closing edge)', () => {
    expect(
      perimeter({
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 3 },
          { x: 0, y: 3 },
        ],
      }),
    ).toBe(14);
  });
  it('open shapes return 0', () => {
    expect(perimeter({ type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } })).toBe(0);
    expect(
      perimeter({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    ).toBe(0);
    expect(perimeter({ type: 'point', position: { x: 0, y: 0 } })).toBe(0);
  });
});

describe('length', () => {
  it('line: distance between endpoints', () => {
    expect(length({ type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 4 } })).toBe(5);
  });
  it('polyline: sum of segments (open)', () => {
    expect(
      length({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 3, y: 0 },
          { x: 3, y: 4 },
        ],
      }),
    ).toBe(7);
  });
  it('point: 0', () => {
    expect(length({ type: 'point', position: { x: 1, y: 1 } })).toBe(0);
  });
  it('closed shapes: equals perimeter', () => {
    const rect: Geometry = {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 3,
      height: 4,
      rotation: 0,
    };
    expect(length(rect)).toBe(perimeter(rect));
  });
});

describe('radius', () => {
  it('returns the radius for circles', () => {
    expect(radius({ type: 'circle', center: { x: 0, y: 0 }, radius: 7 })).toBe(7);
  });
  it('returns undefined for non-circles', () => {
    expect(radius({ type: 'point', position: { x: 0, y: 0 } })).toBeUndefined();
    expect(
      radius({ type: 'rectangle', origin: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0 }),
    ).toBeUndefined();
  });
});

describe('centroid', () => {
  it('rectangle (no rotation): origin + (w/2, h/2)', () => {
    expect(
      centroid({
        type: 'rectangle',
        origin: { x: 10, y: 20 },
        width: 6,
        height: 8,
        rotation: 0,
      }),
    ).toEqual({ x: 13, y: 24 });
  });
  it('rectangle (90° rotation): local (w/2, h/2) rotates about origin', () => {
    const c = centroid({
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 10,
      height: 4,
      rotation: 90,
    });
    expect(c.x).toBeCloseTo(-2);
    expect(c.y).toBeCloseTo(5);
  });
  it('circle: center', () => {
    expect(centroid({ type: 'circle', center: { x: 3, y: 4 }, radius: 7 })).toEqual({ x: 3, y: 4 });
  });
  it('line: midpoint', () => {
    expect(centroid({ type: 'line', start: { x: 0, y: 0 }, end: { x: 6, y: 0 } })).toEqual({
      x: 3,
      y: 0,
    });
  });
  it('polygon: average of vertices', () => {
    expect(
      centroid({
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
        ],
      }),
    ).toEqual({ x: 2, y: 2 });
  });
});

describe('boundingBox', () => {
  it('rectangle (no rotation)', () => {
    expect(
      boundingBox({ type: 'rectangle', origin: { x: 1, y: 2 }, width: 3, height: 4, rotation: 0 }),
    ).toEqual({ min: { x: 1, y: 2 }, max: { x: 4, y: 6 } });
  });
  it('circle expands by radius in both directions', () => {
    expect(boundingBox({ type: 'circle', center: { x: 5, y: 5 }, radius: 2 })).toEqual({
      min: { x: 3, y: 3 },
      max: { x: 7, y: 7 },
    });
  });
  it('polyline covers all points', () => {
    expect(
      boundingBox({
        type: 'polyline',
        points: [
          { x: -1, y: 4 },
          { x: 7, y: 0 },
          { x: 2, y: -3 },
        ],
      }),
    ).toEqual({ min: { x: -1, y: -3 }, max: { x: 7, y: 4 } });
  });
});
