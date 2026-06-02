import type { Geometry, Point } from '@osdlabel/annotation';

const DEG_TO_RAD = Math.PI / 180;

/** Euclidean distance between two points (image-pixel space). */
export function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Area of a geometry in image-px². Returns `0` for zero-area geometries
 * (points, lines, single-point polylines). Polygon area is the absolute
 * value of the signed shoelace area (so winding direction doesn't matter).
 */
export function area(geometry: Geometry): number {
  switch (geometry.type) {
    case 'rectangle':
      return geometry.width * geometry.height;
    case 'circle':
      return Math.PI * geometry.radius * geometry.radius;
    case 'polygon':
      return polygonShoelaceArea(geometry.points);
    case 'line':
    case 'point':
    case 'polyline':
      return 0;
  }
}

/**
 * Closed-perimeter of a geometry in image-px. For open shapes (lines,
 * polylines, points) returns `0` — use {@link length} for those.
 */
export function perimeter(geometry: Geometry): number {
  switch (geometry.type) {
    case 'rectangle':
      return 2 * (geometry.width + geometry.height);
    case 'circle':
      return 2 * Math.PI * geometry.radius;
    case 'polygon':
      return polygonPerimeter(geometry.points);
    case 'line':
    case 'point':
    case 'polyline':
      return 0;
  }
}

/**
 * Open-curve length of a geometry in image-px. For closed shapes
 * (rectangle, circle, polygon) this equals {@link perimeter}; for points
 * returns `0`.
 */
export function length(geometry: Geometry): number {
  switch (geometry.type) {
    case 'line':
      return distance(geometry.start, geometry.end);
    case 'polyline':
      return polylineLength(geometry.points);
    case 'rectangle':
    case 'circle':
    case 'polygon':
      return perimeter(geometry);
    case 'point':
      return 0;
  }
}

/** Radius of a circle in image-px; `undefined` for non-circles. */
export function radius(geometry: Geometry): number | undefined {
  return geometry.type === 'circle' ? geometry.radius : undefined;
}

/**
 * Geometric centroid in image-px. For rectangles, accounts for the
 * `rotation` field rotating the rect about its `origin` (top-left).
 */
export function centroid(geometry: Geometry): Point {
  switch (geometry.type) {
    case 'rectangle': {
      const localCx = geometry.width / 2;
      const localCy = geometry.height / 2;
      const theta = geometry.rotation * DEG_TO_RAD;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      return {
        x: geometry.origin.x + localCx * cos - localCy * sin,
        y: geometry.origin.y + localCx * sin + localCy * cos,
      };
    }
    case 'circle':
      return geometry.center;
    case 'line':
      return midpoint(geometry.start, geometry.end);
    case 'point':
      return geometry.position;
    case 'polyline':
    case 'polygon':
      return pointsCentroid(geometry.points);
  }
}

/** Axis-aligned bounding box in image-px. */
export function boundingBox(geometry: Geometry): { readonly min: Point; readonly max: Point } {
  switch (geometry.type) {
    case 'rectangle':
      return rectangleBoundingBox(
        geometry.origin,
        geometry.width,
        geometry.height,
        geometry.rotation,
      );
    case 'circle':
      return {
        min: { x: geometry.center.x - geometry.radius, y: geometry.center.y - geometry.radius },
        max: { x: geometry.center.x + geometry.radius, y: geometry.center.y + geometry.radius },
      };
    case 'line':
      return pointsBoundingBox([geometry.start, geometry.end]);
    case 'point':
      return { min: geometry.position, max: geometry.position };
    case 'polyline':
    case 'polygon':
      return pointsBoundingBox(geometry.points);
  }
}

/** Midpoint between two points. */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function polygonShoelaceArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function polygonPerimeter(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distance(points[i]!, points[(i + 1) % points.length]!);
  }
  return total;
}

function polylineLength(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += distance(points[i]!, points[i + 1]!);
  }
  return total;
}

// Vertex-average centroid: fast and accurate for regular polygons. For highly
// irregular polygons it skews toward dense vertex clusters; the area-weighted
// shoelace centroid (which also requires a degenerate-polygon fallback) would
// be the upgrade if label placement becomes a real problem.
function pointsCentroid(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

function pointsBoundingBox(points: readonly Point[]): { readonly min: Point; readonly max: Point } {
  if (points.length === 0) {
    return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function rectangleBoundingBox(
  origin: Point,
  width: number,
  height: number,
  rotationDeg: number,
): { readonly min: Point; readonly max: Point } {
  const theta = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((c) => ({
    x: origin.x + c.x * cos - c.y * sin,
    y: origin.y + c.x * sin + c.y * cos,
  }));
  return pointsBoundingBox(corners);
}
