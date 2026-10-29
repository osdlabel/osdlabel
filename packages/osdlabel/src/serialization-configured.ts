import type { Annotation, AnnotationId } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import { OsdAnnotationSchema } from '@osdlabel/validation';
import { migrateLegacyRectangle } from '@osdlabel/fabric-annotations';
import type { OsdFields } from './types.js';
import * as v from 'valibot';

/** Error type for serialization/deserialization failures */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/** Result of deserializing an annotation array */
export interface DeserializeResult<E extends object = Record<never, never>> {
  readonly byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>>;
}

/** Serialize OSD annotation state into a flat array of annotations */
export function serialize(state: AnnotationState<OsdFields>): Annotation<OsdFields>[] {
  return getAllAnnotationsFlat(state);
}

/** Deserialize with OSD field validation (contextId + rawAnnotationData) */
export function deserialize(doc: unknown): DeserializeResult<OsdFields> {
  let annotations: Annotation<OsdFields>[];
  try {
    annotations = v.parse(v.array(OsdAnnotationSchema), doc) as unknown as Annotation<OsdFields>[];
  } catch (err) {
    throw new SerializationError(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const byImage: Record<ImageId, Record<AnnotationId, Annotation<OsdFields>>> = {};
  for (const parsed of annotations) {
    // Rectangles saved before they were placed by their centre recorded a
    // corner they were not painted at; their geometry is corrected here, so
    // what is measured and exported matches what is on screen.
    const ann = migrateLegacyRectangle(parsed);
    const existing = byImage[ann.imageId];
    if (existing) {
      existing[ann.id] = ann;
    } else {
      byImage[ann.imageId] = { [ann.id]: ann };
    }
  }

  return { byImage };
}
