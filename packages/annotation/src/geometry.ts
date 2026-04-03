/** 2D point in image-space coordinates */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface RectangleGeometry {
  readonly type: 'rectangle';
  readonly origin: Point;
  readonly width: number;
  readonly height: number;
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
