import { version as FABRIC_VERSION } from 'fabric';
import { createAnnotationId, type AnnotationId } from '@osdlabel/annotation';
import { createImageId, type ImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId, type AnnotationContextId } from '@osdlabel/annotation-context';
import type { OsdAnnotation } from 'osdlabel';

/** What `actions.addAnnotation` takes: the reducer stamps the timestamps. */
export type NewAnnotation = Omit<OsdAnnotation, 'createdAt' | 'updatedAt'>;

export const imageId: ImageId = createImageId('img1');
export const contextId: AnnotationContextId = createAnnotationContextId('ctx1');

/** A 10x10 rectangle at the origin. */
export function rect(
  id: string,
  fields: Partial<Pick<NewAnnotation, 'imageId' | 'contextId'>> = {},
): NewAnnotation {
  return {
    id: createAnnotationId(id),
    imageId: fields.imageId ?? imageId,
    contextId: fields.contextId ?? contextId,
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
    rawAnnotationData: {
      format: 'fabric',
      fabricVersion: FABRIC_VERSION,
      data: { type: 'Rect', left: 0, top: 0, width: 10, height: 10 },
    },
  };
}

/** A circle at (50,50) r=10, so its bounding box is (40,40) 20x20. */
export function circle(
  id: string,
  fields: Partial<Pick<NewAnnotation, 'imageId' | 'contextId'>> = {},
): NewAnnotation {
  return {
    id: createAnnotationId(id),
    imageId: fields.imageId ?? imageId,
    contextId: fields.contextId ?? contextId,
    toolType: 'circle',
    geometry: { type: 'circle', center: { x: 50, y: 50 }, radius: 10 },
    rawAnnotationData: {
      format: 'fabric',
      fabricVersion: FABRIC_VERSION,
      data: { type: 'Circle', left: 40, top: 40, radius: 10 },
    },
  };
}

/** A stored annotation, as `initialAnnotations` / `loadAnnotations` take it. */
export function stored(annotation: NewAnnotation): OsdAnnotation {
  return {
    ...annotation,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** `initialAnnotations` for one image. */
export function byImage(
  ...annotations: readonly NewAnnotation[]
): Record<ImageId, Record<AnnotationId, OsdAnnotation>> {
  const result: Record<ImageId, Record<AnnotationId, OsdAnnotation>> = {};
  for (const a of annotations) {
    result[a.imageId] = { ...result[a.imageId], [a.id]: stored(a) };
  }
  return result;
}
