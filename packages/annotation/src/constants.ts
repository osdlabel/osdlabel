import type { AnnotationStyle } from './annotation.js';

/**
 * Radius used to render `point` annotations when a style does not set
 * {@link AnnotationStyle.pointRadius}. In image pixels.
 */
export const DEFAULT_POINT_RADIUS = 5;

/** Default visual style applied to new annotations */
export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
  strokeColor: '#ff0000',
  strokeWidth: 2,
  fillColor: '#ff0000',
  fillOpacity: 0.1,
  opacity: 1,
  pointRadius: DEFAULT_POINT_RADIUS,
} as const;
