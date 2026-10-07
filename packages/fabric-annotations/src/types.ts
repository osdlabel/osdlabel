import type { Canvas } from 'fabric';
import type { MaskRawAnnotationData, Point, RawAnnotationData } from '@osdlabel/annotation';

/** Minimal overlay interface that annotation tools require. */
export interface ToolOverlay {
  readonly canvas: Canvas;
  imageToScreen(point: Point): Point;
  /**
   * The press that produced a forwarded `pointerdown`, or `undefined` if the
   * event is not one the overlay forwarded as a press.
   *
   * A tool that accumulates state on press stamps each entry with this, so a
   * double click can drop exactly what its own presses added (#176). Treat
   * `undefined` as "not a tracked press, never drop it" — that is both the
   * safe default and the right answer for a hand-built test event.
   */
  pressSeqOf(event: PointerEvent): number | undefined;
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
