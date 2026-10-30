/** 2D point in image-space coordinates */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A rectangle in image-space pixels, possibly rotated.
 *
 * `origin`, `width` and `height` give the box before rotation: it covers
 * `origin` to `origin + (width, height)`. `rotation` then turns that box
 * about its own centre, `origin + (width / 2, height / 2)`, so rotating a
 * rectangle changes only `rotation`. Once rotated, `origin` is no longer a
 * corner of the shape; `rectangleCorners` in `@osdlabel/geometry` gives the
 * corners.
 */
export interface RectangleGeometry {
  readonly type: 'rectangle';
  /** Top-left corner of the box before rotation. */
  readonly origin: Point;
  /** Width of the box before rotation. */
  readonly width: number;
  /** Height of the box before rotation. */
  readonly height: number;
  /** Clockwise rotation about the box's centre, in degrees (image y points down). */
  readonly rotation: number;
}

export interface CircleGeometry {
  readonly type: 'circle';
  readonly center: Point;
  readonly radius: number;
}

export interface LineGeometry {
  readonly type: 'line';
  readonly start: Point;
  readonly end: Point;
}

export interface PointGeometry {
  readonly type: 'point';
  readonly position: Point;
}

export interface PolylineGeometry {
  readonly type: 'polyline';
  readonly points: readonly Point[];
}

export interface PolygonGeometry {
  readonly type: 'polygon';
  readonly points: readonly Point[];
}

/** Discriminated union of annotation geometries */
export type Geometry =
  | RectangleGeometry
  | CircleGeometry
  | LineGeometry
  | PointGeometry
  | PolylineGeometry
  | PolygonGeometry;
/** Geometry discriminator values — derived from the Geometry union */

export type GeometryType = Geometry['type'];
