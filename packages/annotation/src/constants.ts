import type { AnnotationStyle } from './annotation.js';

/** Default visual style applied to new annotations */
export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
  strokeColor: '#ff0000',
  strokeWidth: 2,
  fillColor: '#ff0000',
  fillOpacity: 0.1,
  opacity: 1,
} as const;
