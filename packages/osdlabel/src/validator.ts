import * as v from 'valibot';
import { BaseAnnotationSchema, RawAnnotationDataSchema } from '@osdlabel/validation';
import type { OsdFields } from './types.js';
import type { Annotation } from '@osdlabel/annotation';

export const OsdFieldsSchema = v.object({
  contextId: v.pipe(v.string(), v.minLength(1)),
  rawAnnotationData: RawAnnotationDataSchema,
});

export const OsdAnnotationSchema = v.intersect([BaseAnnotationSchema, OsdFieldsSchema]);

/** Validates both context and Fabric extension fields */
export const validateOsdFields = (value: unknown): value is OsdFields => {
  return v.safeParse(OsdFieldsSchema, value).success;
};

/** Pre-configured validator for OsdAnnotation */
export const validateOsdAnnotation = (value: unknown): value is Annotation<OsdFields> => {
  return v.safeParse(OsdAnnotationSchema, value).success;
};
