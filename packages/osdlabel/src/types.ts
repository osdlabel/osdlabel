import type { Annotation } from '@osdlabel/annotation';
import type { ContextFields } from '@osdlabel/annotation-context';
import type { FabricFields } from '@osdlabel/fabric-annotations';
import type { ImageIdFields } from '@osdlabel/viewer-api';
import type { FrameFields } from '@osdlabel/frame';

/**
 * OSD-specific extension fields (imageId + context + Fabric, and optionally
 * the frame of a multi-frame source — absent means series-level).
 */
export type OsdFields = ImageIdFields & ContextFields & FabricFields & Partial<FrameFields>;

/** Full annotation type used in osdlabel — includes both context and Fabric fields */
export type OsdAnnotation = Annotation<OsdFields>;
