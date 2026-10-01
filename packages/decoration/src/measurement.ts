import type { Geometry, Point } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import * as geom from '@osdlabel/geometry';

/** A scalar measurement with an explicit unit. */
export interface Measurement {
  readonly value: number;
  /** Display unit, e.g. `'px'`, `'mm'`, `'mm²'`, `'µm'`. */
  readonly unit: string;
}

/**
 * Axis along which to apply pixel spacing to a scalar pixel length. Use `'x'`
 * or `'y'` for a length known to lie along that axis, `'mean'` when there is
 * no orientation to recover (e.g. circle radius).
 *
 * A scalar has lost its direction, so no axis choice converts an arbitrary
 * segment correctly when `x !== y`. When you still have the geometry, use
 * {@link measureDistance}, {@link measureLength} or {@link measurePerimeter},
 * which scale each segment per axis.
 */
export type SpacingAxis = 'x' | 'y' | 'mean';

/**
 * Convert a 1-D pixel measurement to physical units using `pixelSpacing`.
 * Returns the original value with unit `'px'` if no spacing is provided.
 *
 * `'mean'` (the default) is exact only for isotropic spacing. On an
 * anisotropic image, measure from the geometry instead — see
 * {@link measureDistance}.
 */
export function toPhysicalLength(
  pixels: number,
  pixelSpacing: PixelSpacing | undefined,
  axis: SpacingAxis = 'mean',
): Measurement {
  if (!pixelSpacing) return { value: pixels, unit: 'px' };
  const factor = axisFactor(pixelSpacing, axis);
  return { value: pixels * factor, unit: pixelSpacing.unit };
}

/**
 * Convert a 2-D pixel-area measurement to physical units. Uses the product
 * of x and y spacing, which is the physically meaningful conversion for
 * area regardless of anisotropy.
 */
export function toPhysicalArea(
  pixelsSquared: number,
  pixelSpacing: PixelSpacing | undefined,
): Measurement {
  if (!pixelSpacing) return { value: pixelsSquared, unit: 'px²' };
  return {
    value: pixelsSquared * pixelSpacing.x * pixelSpacing.y,
    unit: `${pixelSpacing.unit}²`,
  };
}

/**
 * Physical distance between two image-pixel points, converting each axis with
 * its own spacing: `hypot(dx · spacing.x, dy · spacing.y)`.
 *
 * Exact for any orientation and any spacing, unlike converting a pixel
 * distance with {@link toPhysicalLength}. Returns the pixel distance with unit
 * `'px'` if no spacing is provided.
 */
export function measureDistance(
  a: Point,
  b: Point,
  pixelSpacing: PixelSpacing | undefined,
): Measurement {
  if (!pixelSpacing) return { value: geom.distance(a, b), unit: 'px' };
  return {
    value: scaledSegment(b.x - a.x, b.y - a.y, pixelSpacing),
    unit: pixelSpacing.unit,
  };
}

/**
 * Physical open-curve length of a geometry, mirroring `length` from
 * `@osdlabel/geometry`: a line's length, a polyline's summed segments, a closed
 * shape's perimeter (see {@link measurePerimeter}), `0` for a point. Each
 * segment is converted per axis, so the result is exact on anisotropic images
 * (a circle's perimeter is the one approximation; see {@link measurePerimeter}).
 *
 * Returns the pixel length with unit `'px'` if no spacing is provided.
 */
export function measureLength(
  geometry: Geometry,
  pixelSpacing: PixelSpacing | undefined,
): Measurement {
  if (!pixelSpacing) return { value: geom.length(geometry), unit: 'px' };
  switch (geometry.type) {
    case 'line':
      return measureDistance(geometry.start, geometry.end, pixelSpacing);
    case 'polyline':
      return { value: pathLength(geometry.points, false, pixelSpacing), unit: pixelSpacing.unit };
    case 'rectangle':
    case 'circle':
    case 'polygon':
      return measurePerimeter(geometry, pixelSpacing);
    case 'point':
      return { value: 0, unit: pixelSpacing.unit };
  }
}

/**
 * Physical closed perimeter of a geometry, mirroring `perimeter` from
 * `@osdlabel/geometry`: `0` for open shapes (lines, polylines, points).
 *
 * Exact on anisotropic images for rectangles (including rotated ones) and
 * polygons, whose edges are converted per axis. A circle drawn in image pixels
 * is physically an ellipse with semi-axes `r · spacing.x` and `r · spacing.y`;
 * its perimeter uses Ramanujan's second approximation: exact when the spacing
 * is isotropic, within 1e-6 relative at a 1:5 spacing ratio, and within 0.03%
 * even at 1:100.
 *
 * Returns the pixel perimeter with unit `'px'` if no spacing is provided.
 */
export function measurePerimeter(
  geometry: Geometry,
  pixelSpacing: PixelSpacing | undefined,
): Measurement {
  if (!pixelSpacing) return { value: geom.perimeter(geometry), unit: 'px' };
  const unit = pixelSpacing.unit;
  switch (geometry.type) {
    case 'rectangle': {
      // Edge vectors of the rectangle rotated about its origin.
      const theta = (geometry.rotation * Math.PI) / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const w = scaledSegment(geometry.width * cos, geometry.width * sin, pixelSpacing);
      const h = scaledSegment(-geometry.height * sin, geometry.height * cos, pixelSpacing);
      return { value: 2 * (w + h), unit };
    }
    case 'circle':
      return {
        value: ellipsePerimeter(geometry.radius * pixelSpacing.x, geometry.radius * pixelSpacing.y),
        unit,
      };
    case 'polygon':
      return { value: pathLength(geometry.points, true, pixelSpacing), unit };
    case 'line':
    case 'point':
    case 'polyline':
      return { value: 0, unit };
  }
}

/** Default formatting options for `formatMeasurement`. */
export interface FormatMeasurementOptions {
  /** Number of fractional digits (default: 2). */
  readonly precision?: number | undefined;
  /** Separator between the numeric value and the unit (default: `' '`). */
  readonly unitSeparator?: string | undefined;
}

/** Render a measurement to a human-readable string (e.g. `"12.34 mm"`). */
export function formatMeasurement(m: Measurement, options?: FormatMeasurementOptions): string {
  const precision = options?.precision ?? 2;
  const sep = options?.unitSeparator ?? ' ';
  return `${m.value.toFixed(precision)}${sep}${m.unit}`;
}

function axisFactor(spacing: PixelSpacing, axis: SpacingAxis): number {
  if (axis === 'x') return spacing.x;
  if (axis === 'y') return spacing.y;
  return (spacing.x + spacing.y) / 2;
}

function scaledSegment(dx: number, dy: number, spacing: PixelSpacing): number {
  return Math.hypot(dx * spacing.x, dy * spacing.y);
}

/** Summed per-axis segment lengths; `closed` adds the last-to-first edge. */
function pathLength(points: readonly Point[], closed: boolean, spacing: PixelSpacing): number {
  if (points.length < 2) return 0;
  const edges = closed ? points.length : points.length - 1;
  let total = 0;
  for (let i = 0; i < edges; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += scaledSegment(b.x - a.x, b.y - a.y, spacing);
  }
  return total;
}

/**
 * Ramanujan's second approximation to an ellipse's perimeter. Reduces to
 * `2πa` exactly when `a === b`.
 */
function ellipsePerimeter(a: number, b: number): number {
  if (a + b === 0) return 0;
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}
