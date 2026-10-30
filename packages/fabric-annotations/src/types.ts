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
  /**
   * Whether a `pointerup` ends a press that was cancelled rather than one the
   * user lifted: by the platform (palm rejection, a system gesture), or by
   * `FabricOverlay` itself, for a touch press a pen or a mouse pressed during
   * (a touch never wins over either). Fabric has no `pointercancel`, so a
   * cancel reaches a tool as a release; a tool that commits on release should
   * discard on one of these instead. Optional, so an overlay that cannot tell
   * reports every release as a lift.
   */
  isCancelledRelease?(event: PointerEvent): boolean;
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
