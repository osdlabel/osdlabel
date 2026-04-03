import type { AnnotationId } from './annotation';
import type { ToolType } from './annotation-tool';
import type { GeometryType } from './geometry';
import type { ImageId } from './types';

/** Maps a ToolType to the GeometryType it produces */

export function toolTypeToGeometryType(toolType: ToolType): GeometryType {
  if (toolType === 'freeHandPath') return 'polyline';
  return toolType as GeometryType;
} // ── ID Factory Functions ─────────────────────────────────────────────────

export function createAnnotationId(value: string): AnnotationId {
  return value as AnnotationId;
}

export function createImageId(value: string): ImageId {
  return value as ImageId;
}
