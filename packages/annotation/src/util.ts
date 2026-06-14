import type { AnnotationId } from './annotation';
import type { ToolType } from './annotation-tool';
import type { GeometryType } from './geometry';

/** Maps a ToolType to the GeometryType it produces */

export function toolTypeToGeometryType(toolType: ToolType): GeometryType {
  if (toolType === 'freeHandPath') return 'polyline';
  if (toolType === 'segmentation') return 'polygon';
  return toolType as GeometryType;
} // ── ID Factory Functions ─────────────────────────────────────────────────

export function createAnnotationId(value: string): AnnotationId {
  return value as AnnotationId;
}
