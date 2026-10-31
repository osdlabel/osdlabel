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
  /**
   * Top-left of the mask's bounding box, in image-space (level-0) pixels —
   * at every {@link MaskGeometry.downsample | downsample}.
   */
  readonly origin: Point;
  /** Bounding-box width in image (level-0) pixels, at every downsample. */
  readonly width: number;
  /** Bounding-box height in image (level-0) pixels, at every downsample. */
  readonly height: number;
  /**
   * Exact number of image (level-0) pixels the mask covers, which makes a
   * mask's area exact rather than an approximation traced from an outline.
   *
   * At a downsample above 1 each stored mask cell stands for a
   * `downsample x downsample` block of image pixels (clipped at the image's
   * right and bottom edges), and this counts the image pixels those blocks
   * cover — so `area()` reads it unchanged at every resolution.
   */
  readonly pixelCount: number;
  /**
   * Image pixels per stored mask cell, along each axis: a power of two, `1`
   * (the default, and what an absent field means) storing one cell per image
   * pixel.
   *
   * The same factor OpenSlide calls a level's `downsample`. A mask painted or
   * predicted at overview zoom is stored at a coarser grid so its bounding box
   * — which can span most of a whole-slide image — fits the mask pixel cap.
   * Everything else on this type stays in level-0 image pixels; only the
   * payload's cell grid is coarser.
   */
  readonly downsample?: number;
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
