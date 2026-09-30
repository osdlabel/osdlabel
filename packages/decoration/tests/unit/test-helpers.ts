import type { Annotation, AnnotationId, ToolType } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { DecorationContext } from '../../src/provider.js';

/** A bare annotation with no extension fields. */
export type TestAnnotation = Annotation;

export const annId = (s: string): AnnotationId => s as AnnotationId;

export function ann(
  id: string,
  toolType: ToolType,
  geometry: TestAnnotation['geometry'],
  label?: string,
): TestAnnotation {
  return {
    id: annId(id),
    geometry,
    toolType,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Builds a complete {@link DecorationContext}. Routing every provider
 * invocation through this means a new required field on `DecorationContext`
 * breaks exactly one call site — this one — instead of every test.
 */
export function ctx(
  annotations: readonly TestAnnotation[],
  extra?: {
    readonly pixelSpacing?: PixelSpacing | undefined;
    readonly selectedAnnotationId?: AnnotationId | null;
  },
): DecorationContext {
  return {
    annotations,
    selectedAnnotationId: extra?.selectedAnnotationId ?? null,
    ...(extra?.pixelSpacing !== undefined ? { pixelSpacing: extra.pixelSpacing } : {}),
  };
}
