import type { Canvas } from 'fabric';
import type { Point, RawAnnotationData } from '@osdlabel/annotation';

/** Minimal overlay interface that annotation tools require. */
export interface ToolOverlay {
  readonly canvas: Canvas;
  imageToScreen(point: Point): Point;
}

export interface FabricRawAnnotationData extends RawAnnotationData<'fabric'> {
  fabricVersion: string;
}

/** Extension fields added by the Fabric rendering layer. */
export interface FabricFields {
  readonly rawAnnotationData: FabricRawAnnotationData;
}
