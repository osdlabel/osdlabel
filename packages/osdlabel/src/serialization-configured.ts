import { serialize as baseSerialize, deserialize as baseDeserialize } from '@osdlabel/annotation';
import type { AnnotationState, DeserializeResult, Annotation } from '@osdlabel/annotation';
import { OsdAnnotationSchema } from './validator.js';
import type { OsdFields } from './types.js';
import * as v from 'valibot';
import { SerializationError } from '@osdlabel/annotation';

/** Serialize OSD annotation state into a flat array of annotations */
export function serialize(state: AnnotationState<OsdFields>): Annotation<OsdFields>[] {
  return baseSerialize(state);
}

/** Deserialize with OSD field validation (contextId + rawAnnotationData) */
export function deserialize(doc: unknown): DeserializeResult<OsdFields> {
  let parsed: unknown;
  try {
    parsed = v.parse(v.array(OsdAnnotationSchema), doc);
  } catch (err) {
    throw new SerializationError(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return baseDeserialize(parsed);
}
