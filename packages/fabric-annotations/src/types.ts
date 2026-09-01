import type { Canvas } from 'fabric';
import type { MaskRawAnnotationData, Point, RawAnnotationData } from '@osdlabel/annotation';

/** Minimal overlay interface that annotation tools require. */
export interface ToolOverlay {
  readonly canvas: Canvas;
  imageToScreen(point: Point): Point;
}

export interface FabricRawAnnotationData extends RawAnnotationData<'fabric'> {
  fabricVersion: string;
}

/**
 * The raw-data envelope an annotation carries.
 *
 * Vector annotations round-trip through Fabric's own serialization; masks
 * carry a pixel payload instead, since there is no meaningful Fabric object to
 * serialize for them (a `FabricImage` would embed a huge data URL). Narrow on
 * `format` before reading `data`.
 */
export type AnnotationRawData = FabricRawAnnotationData | MaskRawAnnotationData;

/** Extension fields added by the Fabric rendering layer. */
export interface FabricFields {
  readonly rawAnnotationData: AnnotationRawData;
}
