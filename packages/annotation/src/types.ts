import type { Geometry } from './geometry';

// ── Tool & Geometry Type Aliases ────────────────────────────────────────

/** Tool used to create an annotation. Multiple tools may produce the same geometry type. */
export type ToolType = 'rectangle' | 'circle' | 'line' | 'point' | 'polyline' | 'freeHandPath';

/** Geometry discriminator values — derived from the Geometry union */
export type GeometryType = Geometry['type'];

/** Maps a ToolType to the GeometryType it produces */
export function toolTypeToGeometryType(toolType: ToolType): GeometryType {
  if (toolType === 'freeHandPath') return 'polyline';
  return toolType as GeometryType;
}

// ── Branded ID Types ────────────────────────────────────────────────────

declare const annotationIdBrand: unique symbol;
declare const imageIdBrand: unique symbol;
/** Unique annotation identifier */
export type AnnotationId = string & { readonly __brand: typeof annotationIdBrand };

/** Unique image identifier */
export type ImageId = string & { readonly __brand: typeof imageIdBrand };

// ── ID Factory Functions ─────────────────────────────────────────────────

export function createAnnotationId(value: string): AnnotationId {
  return value as AnnotationId;
}

export function createImageId(value: string): ImageId {
  return value as ImageId;
}

/** Visual styling for an annotation */
export interface AnnotationStyle {
  readonly strokeColor: string;
  /** Stroke width in screen pixels */
  readonly strokeWidth: number;
  readonly strokeDashArray?: readonly number[];
  readonly fillColor: string;
  readonly fillOpacity: number;
  readonly opacity: number;
}

// ── Raw Annotation Data ──────────────────────────────────────────────────

/** Discriminated union for raw annotation data from rendering libraries */
export type RawAnnotationData = {
  readonly format: 'fabric';
  readonly fabricVersion: string;
  readonly data: Record<string, unknown>;
};

// ── Annotation Entity ────────────────────────────────────────────────────

/** Base annotation without extension fields */
export interface BaseAnnotation {
  readonly id: AnnotationId;
  readonly imageId: ImageId;
  readonly geometry: Geometry;
  readonly toolType: ToolType;
  readonly label?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Generic annotation type. Extensions add fields via intersection.
 * Default: `Record<string, never>` (no extensions — bare BaseAnnotation).
 */
export type Annotation<E extends object = Record<string, never>> = BaseAnnotation & E;

// ── Serialization Types ──────────────────────────────────────────────────

/** Top-level serialization envelope */
export interface AnnotationDocument<E extends object = Record<string, never>> {
  readonly version: '1.0.0';
  readonly exportedAt: string;
  readonly images: readonly ImageAnnotations<E>[];
}

/** Annotations for a single image */
export interface ImageAnnotations<E extends object = Record<string, never>> {
  readonly imageId: ImageId;
  readonly sourceUrl: string;
  readonly annotations: readonly Annotation<E>[];
}

// ── Image Source ──────────────────────────────────────────────────────────

/** Image source descriptor */
export interface ImageSource {
  readonly id: ImageId;
  readonly tileSource: string;
  readonly thumbnailUrl?: string | undefined;
  readonly label?: string | undefined;
}

// ── State Types ──────────────────────────────────────────────────────────
// Note: State container types intentionally omit `readonly` — SolidJS store
// proxies enforce immutability at runtime, and `readonly` here would conflict
// with SolidJS's `SetStoreFunction` path-based API. Data model types above
// (Annotation, Geometry, etc.) remain fully `readonly`.

/** Root state for the annotation system */
export interface AnnotationState<E extends object = Record<string, never>> {
  byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>>;
  /** Monotonically increasing counter; incremented on every mutation for O(1) change detection */
  changeCounter: number;
}
