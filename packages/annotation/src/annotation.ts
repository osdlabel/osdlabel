import type { Geometry } from './geometry';
import type { ToolType } from './annotation-tool';

/** Base annotation without extension fields */
export interface BaseAnnotation {
  readonly id: AnnotationId;
  readonly geometry: Geometry;
  readonly toolType: ToolType;
  readonly label?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Generic annotation type. Extensions add fields via intersection.
 * Default: `Record<never, never>` (no extensions — structurally `BaseAnnotation`).
 *
 * The default must be a mapped type over *no* keys. `Record<string, never>`
 * would be an index signature mapping *every* key to `never`, so the
 * intersection would turn `id` and every other field into `never` — readable,
 * but impossible to construct (#165).
 */
export type Annotation<E extends object = Record<never, never>> = BaseAnnotation & E;

/** Visual styling for an annotation */
export interface AnnotationStyle {
  readonly strokeColor: string;
  /** Stroke width in screen pixels */
  readonly strokeWidth: number;
  readonly strokeDashArray?: readonly number[];
  readonly fillColor: string;
  readonly fillOpacity: number;
  readonly opacity: number;
  /**
   * Radius used to render `point` annotations, in image pixels (the same space
   * as annotation geometry). Falls back to {@link DEFAULT_POINT_RADIUS} when
   * omitted.
   */
  readonly pointRadius?: number;
}

export declare const annotationIdBrand: unique symbol;
/** Unique annotation identifier */
export type AnnotationId = string & { readonly __brand: typeof annotationIdBrand };
