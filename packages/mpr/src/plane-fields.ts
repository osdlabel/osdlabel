import type { Annotation } from '@osdlabel/annotation';
import type { PlaneFrame } from '@osdlabel/spatial';

/**
 * Extension fields that place an annotation in the patient frame.
 *
 * The annotation's `geometry` stays what osdlabel already stores — 2D, in the
 * image space of the cell it was drawn in. `plane` records which plane that
 * image space is, so the same annotation can be projected into any other view
 * of the same frame of reference. It composes with `ImageIdFields` /
 * `ContextFields` / `FabricFields` by intersection, like every other extension.
 */
export interface PlaneFields {
  readonly plane: PlaneFrame;
  /** DICOM FrameOfReferenceUID; projections only make sense within one. */
  readonly frameOfReferenceUid?: string | undefined;
}

export type PlanarAnnotation<E extends object = Record<never, never>> = Annotation<PlaneFields & E>;
