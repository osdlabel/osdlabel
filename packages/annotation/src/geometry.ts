/** 2D point in image-space coordinates */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A rectangle in image-space pixels, possibly rotated.
 *
 * `origin` is a corner, not the centre: the one that is top-left before
 * rotation. From it the rectangle spans `width` along the direction `rotation`
 * degrees clockwise from the +x axis (image y points down), and `height` at a
 * right angle to that, clockwise again. At `rotation: 0` it covers `origin` to
 * `origin + (width, height)`. The editor rotates a rectangle about its centre,
 * so rotating one there moves its `origin`.
 */
export interface RectangleGeometry {
  readonly type: 'rectangle';
  /** The corner that is top-left before rotation. */
  readonly origin: Point;
  /** Extent along the rotated x axis. */
  readonly width: number;
  /** Extent along the rotated y axis. */
  readonly height: number;
  /** Clockwise rotation about `origin`, in degrees. */
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
