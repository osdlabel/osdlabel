/** The type of the annotation tool used to create an annotation.
 * Multiple tools may produce the same geometry type. */
export type ToolType =
  | 'rectangle'
  | 'circle'
  | 'line'
  | 'point'
  | 'polyline'
  | 'freeHandPath'
  | 'segmentation';
