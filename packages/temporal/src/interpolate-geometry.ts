import type { Geometry, Point } from '@osdlabel/annotation';
import type { Correspondence } from './contour-correspondence.js';
import { polygonCorrespondence, polylineCorrespondence } from './contour-correspondence.js';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Degrees, along the shorter way round (350 -> 10 passes through 0). */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

function lerpPoints(from: readonly Point[], to: readonly Point[], t: number): Point[] {
  const out: Point[] = new Array<Point>(from.length);
  for (let i = 0; i < from.length; i++) out[i] = lerpPoint(from[i]!, to[i]!, t);
  return out;
}

/** Whether two geometries of this type can be blended (masks cannot). */
export function isInterpolable(type: Geometry['type']): boolean {
  return type !== 'mask';
}

/**
 * Correspondence for a contour pair, or `null` for geometry types that need
 * none. Pure; {@link interpolateGeometry} accepts a cached one.
 */
export function correspondenceFor(a: Geometry, b: Geometry): Correspondence | null {
  if (a.type === 'polygon' && b.type === 'polygon')
    return polygonCorrespondence(a.points, b.points);
  if (a.type === 'polyline' && b.type === 'polyline')
    return polylineCorrespondence(a.points, b.points);
  return null;
}

/**
 * Blend two keyframe geometries of the same type at `t` in [0, 1]. `t = 0`
 * and `t = 1` return the inputs themselves (by identity). Masks and mixed
 * types are not blended: the caller holds a keyframe instead.
 */
export function interpolateGeometry(
  a: Geometry,
  b: Geometry,
  t: number,
  correspondence?: Correspondence | null,
): Geometry {
  if (t <= 0) return a;
  if (t >= 1) return b;
  switch (a.type) {
    case 'rectangle': {
      if (b.type !== 'rectangle') return a;
      return {
        type: 'rectangle',
        origin: lerpPoint(a.origin, b.origin, t),
        width: lerp(a.width, b.width, t),
        height: lerp(a.height, b.height, t),
        rotation: lerpAngle(a.rotation, b.rotation, t),
      };
    }
    case 'circle': {
      if (b.type !== 'circle') return a;
      return {
        type: 'circle',
        center: lerpPoint(a.center, b.center, t),
        radius: lerp(a.radius, b.radius, t),
      };
    }
    case 'point': {
      if (b.type !== 'point') return a;
      return { type: 'point', position: lerpPoint(a.position, b.position, t) };
    }
    case 'line': {
      if (b.type !== 'line') return a;
      return {
        type: 'line',
        start: lerpPoint(a.start, b.start, t),
        end: lerpPoint(a.end, b.end, t),
      };
    }
    case 'polygon': {
      if (b.type !== 'polygon') return a;
      const c = correspondence ?? polygonCorrespondence(a.points, b.points);
      return { type: 'polygon', points: lerpPoints(c.from, c.to, t) };
    }
    case 'polyline': {
      if (b.type !== 'polyline') return a;
      const c = correspondence ?? polylineCorrespondence(a.points, b.points);
      return { type: 'polyline', points: lerpPoints(c.from, c.to, t) };
    }
    case 'mask':
      return a;
  }
}
