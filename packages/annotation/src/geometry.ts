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

/**
 * A painted raster region.
 *
 * This geometry breaks an invariant the others hold. For every vector shape,
 * `geometry` is complete and authoritative: `rawAnnotationData` preserves
 * Fabric's rendering details, but the annotation could be rebuilt from its
 * geometry alone. A mask cannot work that way — its pixels are far too large
 * to sit in reactive state — so this type carries only a summary (where the
 * mask is, and how much of it is filled) while the pixels themselves live in
 * the annotation's `rawAnnotationData` envelope.
 *
 * The consequence worth remembering: for a mask, the raw envelope holds
 * essential data rather than a regenerable rendering cache, so a mask
 * annotation is **not** reconstructible from its geometry. Helpers that build
 * annotations from geometry alone reject masks for exactly this reason — see
 * `createMaskAnnotation` in `osdlabel`.
 */
export interface MaskGeometry {
  readonly type: 'mask';
  /** Top-left of the mask's bounding box, in image-space pixels. */
  readonly origin: Point;
  /** Bounding-box width in image pixels. */
  readonly width: number;
  /** Bounding-box height in image pixels. */
  readonly height: number;
  /**
   * Exact number of painted pixels, which makes a mask's area exact rather
   * than an approximation traced from an outline.
   */
  readonly pixelCount: number;
}

/** Discriminated union of annotation geometries */
export type Geometry =
  | RectangleGeometry
  | CircleGeometry
  | LineGeometry
  | PointGeometry
  | PolylineGeometry
  | PolygonGeometry
  | MaskGeometry;

/**
 * Every geometry whose shape is fully described by the geometry itself.
 *
 * {@link MaskGeometry} is the exception: it carries only a bounding box and a
 * pixel count, with the pixels themselves in the annotation's raw data. Code
 * that reconstructs a shape from geometry alone — building a Fabric object,
 * seeding an annotation from an external system — takes this narrower type, so
 * handing it a mask is a compile error rather than a runtime throw.
 */
export type VectorGeometry = Exclude<Geometry, MaskGeometry>;

/** Geometry discriminator values — derived from the Geometry union */
export type GeometryType = Geometry['type'];
