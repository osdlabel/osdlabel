import * as v from 'valibot';
import { MAX_IMAGE_DIMENSION } from './constants.js';

/** Finite number check (rejects NaN, Infinity, -Infinity) */
const FiniteNumber = v.pipe(v.number(), v.finite());

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").Point}. */
export const PointSchema = v.object({
  x: FiniteNumber,
  y: FiniteNumber,
});

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").RectangleGeometry}. */
export const RectangleGeometrySchema = v.object({
  type: v.literal('rectangle'),
  origin: PointSchema,
  width: FiniteNumber,
  height: FiniteNumber,
  rotation: FiniteNumber,
});

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").CircleGeometry}. */
export const CircleGeometrySchema = v.object({
  type: v.literal('circle'),
  center: PointSchema,
  radius: FiniteNumber,
});

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").LineGeometry}. */
export const LineGeometrySchema = v.object({
  type: v.literal('line'),
  start: PointSchema,
  end: PointSchema,
});

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").PointGeometry}. */
export const PointGeometrySchema = v.object({
  type: v.literal('point'),
  position: PointSchema,
});

const PolyPointsSchema = v.pipe(v.array(PointSchema), v.minLength(2));

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").PolylineGeometry}. */
export const PolylineGeometrySchema = v.object({
  type: v.literal('polyline'),
  points: PolyPointsSchema,
});

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").PolygonGeometry}. */
export const PolygonGeometrySchema = v.object({
  type: v.literal('polygon'),
  points: PolyPointsSchema,
});

/** A schema for validating @see {@link import("@osdlabel/annotation/geometry").MaskGeometry}. */
export const MaskGeometrySchema = v.pipe(
  v.object({
    type: v.literal('mask'),
    origin: PointSchema,
    // Bounded by the image, not by anything tighter: the mask's real limit is
    // its area, and a side bound below the image bound refuses boxes the brush
    // can paint. See MAX_IMAGE_DIMENSION.
    width: v.pipe(FiniteNumber, v.minValue(0), v.maxValue(MAX_IMAGE_DIMENSION)),
    height: v.pipe(FiniteNumber, v.minValue(0), v.maxValue(MAX_IMAGE_DIMENSION)),
    pixelCount: v.pipe(FiniteNumber, v.minValue(0)),
  }),
  // A mask cannot contain more painted pixels than its own bounding box holds;
  // area() trusts pixelCount, so an inflated value would report a false area.
  v.check(
    (g) => g.pixelCount <= g.width * g.height,
    'Mask pixelCount cannot exceed its bounding-box area',
  ),
);

export const GeometrySchema = v.variant('type', [
  RectangleGeometrySchema,
  CircleGeometrySchema,
  LineGeometrySchema,
  PointGeometrySchema,
  PolylineGeometrySchema,
  PolygonGeometrySchema,
  MaskGeometrySchema,
]);
