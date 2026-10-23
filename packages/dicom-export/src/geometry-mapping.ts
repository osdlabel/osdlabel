import type { Geometry, Point, VectorGeometry } from '@osdlabel/annotation';

/** SR SCOORD graphic types (PS3.3 C.18.6.1.2). */
export type ScoordGraphicType = 'POINT' | 'MULTIPOINT' | 'POLYLINE' | 'CIRCLE' | 'ELLIPSE';
/** Microscopy Bulk Simple Annotations graphic types (C.37.1.2). */
export type AnnGraphicType = 'POINT' | 'POLYLINE' | 'POLYGON' | 'ELLIPSE' | 'RECTANGLE';

/** Corners of a (possibly rotated) rectangle: TL, TR, BR, BL — rotation is about the origin. */
export function rectangleCorners(g: Extract<Geometry, { type: 'rectangle' }>): Point[] {
  const t = (g.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const at = (dx: number, dy: number): Point => ({
    x: g.origin.x + dx * c - dy * s,
    y: g.origin.y + dx * s + dy * c,
  });
  return [at(0, 0), at(g.width, 0), at(g.width, g.height), at(0, g.height)];
}

/**
 * osdlabel geometry → SR SCOORD. No coordinate transform is needed: SCOORD
 * puts 0.0\0.0 at the top-left corner of the top-left pixel (C.18.6.1.1),
 * which is exactly osdlabel's image space. Closed shapes become closed
 * POLYLINEs (first point repeated), as SCOORD has no POLYGON.
 */
export function toScoord(g: VectorGeometry): {
  readonly graphicType: ScoordGraphicType;
  readonly points: readonly Point[];
} {
  switch (g.type) {
    case 'point':
      return { graphicType: 'POINT', points: [g.position] };
    case 'line':
      return { graphicType: 'POLYLINE', points: [g.start, g.end] };
    case 'polyline':
      return { graphicType: 'POLYLINE', points: g.points };
    case 'polygon':
      return { graphicType: 'POLYLINE', points: [...g.points, g.points[0]!] };
    case 'rectangle': {
      const c = rectangleCorners(g);
      return { graphicType: 'POLYLINE', points: [...c, c[0]!] };
    }
    case 'circle':
      return {
        graphicType: 'CIRCLE',
        points: [g.center, { x: g.center.x + g.radius, y: g.center.y }],
      };
  }
}

const close = (a: Point, b: Point, eps: number): boolean =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/**
 * SCOORD → osdlabel geometry. A closed 5-point polyline whose corners are
 * right angles is read back as a rectangle (with its rotation), so a
 * rectangle survives the round trip as a rectangle rather than a polygon.
 */
export function fromScoord(
  graphicType: string,
  points: readonly Point[],
  eps = 1e-2,
): VectorGeometry {
  switch (graphicType) {
    case 'POINT':
      return { type: 'point', position: points[0]! };
    case 'CIRCLE': {
      const [c, p] = points as [Point, Point];
      return { type: 'circle', center: c, radius: Math.hypot(p.x - c.x, p.y - c.y) };
    }
    case 'POLYLINE': {
      const closed = points.length > 3 && close(points[0]!, points[points.length - 1]!, eps);
      if (!closed) {
        return points.length === 2
          ? { type: 'line', start: points[0]!, end: points[1]! }
          : { type: 'polyline', points };
      }
      const ring = points.slice(0, -1);
      if (ring.length === 4) {
        const r = asRectangle(ring, eps);
        if (r) return r;
      }
      return { type: 'polygon', points: ring };
    }
    default:
      throw new Error(`unsupported SCOORD graphic type ${graphicType}`);
  }
}

function asRectangle(c: readonly Point[], eps: number): VectorGeometry | undefined {
  const [a, b, , d] = c as [Point, Point, Point, Point];
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = d.x - a.x;
  const vy = d.y - a.y;
  const w = Math.hypot(ux, uy);
  const h = Math.hypot(vx, vy);
  if (w === 0 || h === 0) return undefined;
  if (Math.abs(ux * vx + uy * vy) > eps * w * h) return undefined; // not a right angle
  const third = { x: a.x + ux + vx, y: a.y + uy + vy };
  if (!close(third, c[2]!, eps * Math.max(1, w, h))) return undefined;
  // Orientation: TL→TR then TL→BL must turn clockwise in y-down space.
  if (ux * vy - uy * vx <= 0) return undefined;
  const rotation = (Math.atan2(uy, ux) * 180) / Math.PI;
  return {
    type: 'rectangle',
    origin: a,
    width: w,
    height: h,
    rotation: Math.abs(rotation) < 1e-9 ? 0 : rotation,
  };
}

/** osdlabel geometry → ANN graphic type and points (POLYGON is implicitly closed). */
export function toAnn(g: VectorGeometry): {
  readonly graphicType: AnnGraphicType;
  readonly points: readonly Point[];
} {
  switch (g.type) {
    case 'point':
      return { graphicType: 'POINT', points: [g.position] };
    case 'line':
      return { graphicType: 'POLYLINE', points: [g.start, g.end] };
    case 'polyline':
      return { graphicType: 'POLYLINE', points: g.points };
    case 'polygon':
      return { graphicType: 'POLYGON', points: g.points };
    case 'rectangle':
      return { graphicType: 'RECTANGLE', points: rectangleCorners(g) };
    case 'circle': {
      const { x, y } = g.center;
      const r = g.radius;
      return {
        graphicType: 'ELLIPSE',
        points: [
          { x: x - r, y },
          { x: x + r, y },
          { x, y: y - r },
          { x, y: y + r },
        ],
      };
    }
  }
}

/** ANN graphic → osdlabel geometry. A circular ELLIPSE becomes a circle; others are approximated. */
export function fromAnn(graphicType: string, points: readonly Point[]): VectorGeometry {
  switch (graphicType) {
    case 'POINT':
      return { type: 'point', position: points[0]! };
    case 'POLYLINE':
      return points.length === 2
        ? { type: 'line', start: points[0]!, end: points[1]! }
        : { type: 'polyline', points };
    case 'POLYGON':
      return { type: 'polygon', points };
    case 'RECTANGLE': {
      const r = asRectangle(points, 1e-2);
      return r ?? { type: 'polygon', points };
    }
    case 'ELLIPSE': {
      const [a, b, c, d] = points as [Point, Point, Point, Point];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const major = Math.hypot(b.x - a.x, b.y - a.y) / 2;
      const minor = Math.hypot(d.x - c.x, d.y - c.y) / 2;
      // osdlabel has no ellipse geometry: a non-circular ellipse is lossy here.
      return { type: 'circle', center, radius: (major + minor) / 2 };
    }
    default:
      throw new Error(`unsupported ANN graphic type ${graphicType}`);
  }
}
