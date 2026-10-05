import * as v from 'valibot';

/** Finite number check (rejects NaN, Infinity, -Infinity) */
const FiniteNumber = v.pipe(v.number(), v.finite());

/** A schema for validating {@link @osdlabel/annotation!Point | Point}. */
export const PointSchema = v.object({
  x: FiniteNumber,
  y: FiniteNumber,
});

/** A schema for validating {@link @osdlabel/annotation!RectangleGeometry | RectangleGeometry}. */
export const RectangleGeometrySchema = v.object({
  type: v.literal('rectangle'),
  origin: PointSchema,
  width: FiniteNumber,
  height: FiniteNumber,
  rotation: FiniteNumber,
});

/** A schema for validating {@link @osdlabel/annotation!CircleGeometry | CircleGeometry}. */
export const CircleGeometrySchema = v.object({
  type: v.literal('circle'),
  center: PointSchema,
  radius: FiniteNumber,
});

/** A schema for validating {@link @osdlabel/annotation!LineGeometry | LineGeometry}. */
export const LineGeometrySchema = v.object({
  type: v.literal('line'),
  start: PointSchema,
  end: PointSchema,
});

/** A schema for validating {@link @osdlabel/annotation!PointGeometry | PointGeometry}. */
export const PointGeometrySchema = v.object({
  type: v.literal('point'),
  position: PointSchema,
});

const PolyPointsSchema = v.pipe(v.array(PointSchema), v.minLength(2));

/** A schema for validating {@link @osdlabel/annotation!PolylineGeometry | PolylineGeometry}. */
export const PolylineGeometrySchema = v.object({
  type: v.literal('polyline'),
  points: PolyPointsSchema,
});

/** A schema for validating {@link @osdlabel/annotation!PolygonGeometry | PolygonGeometry}. */
export const PolygonGeometrySchema = v.object({
  type: v.literal('polygon'),
  points: PolyPointsSchema,
});

export const GeometrySchema = v.variant('type', [
  RectangleGeometrySchema,
  CircleGeometrySchema,
  LineGeometrySchema,
  PointGeometrySchema,
  PolylineGeometrySchema,
  PolygonGeometrySchema,
]);
