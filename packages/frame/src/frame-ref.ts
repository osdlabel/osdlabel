import type { Annotation } from '@osdlabel/annotation';

/**
 * Which frame of a multi-frame image source an annotation was drawn on.
 *
 * A "frame" is one 2D plane on the source's single frame axis: a slice of a
 * CT/MR series, a frame of an ultrasound cine loop or a multi-frame instance,
 * or a decoded frame of a video. The image source keeps its one `ImageId`; the
 * frame is a coordinate *within* it, the same way geometry is a coordinate
 * within the plane.
 *
 * Three fields, because the three kinds of source disagree about what is
 * stable:
 *
 * - `index` is what the viewer navigates by and what selectors key on. It is
 *   only stable for as long as the frame axis is presented in the same order.
 * - `key` survives re-ordering and re-loading. A DICOM adapter writes the SOP
 *   Instance UID for a single-frame instance, or DICOMweb's own frame path
 *   (`<SOPInstanceUID>/frames/<n>`, 1-based) for a frame of a multi-frame
 *   instance. The core never interprets it — "speak DICOM, don't be DICOM".
 * - `time` (seconds, presentation time) is authoritative for temporal axes,
 *   where an index depends on the decoder and on variable frame rates.
 *
 * Reconciliation (`reconcileFrameRefs`) rewrites `index` from `key`, then from
 * `time`, when an axis is (re)loaded.
 *
 * Deliberately *not* covered: a plane that was not acquired (an MPR
 * reformat). Its identity is a normal and an offset in volume space, not a
 * position on an acquisition axis; it belongs to a separate extension.
 */
export interface FrameRef {
  /** 0-based position on the source's frame axis, in presentation order. */
  readonly index: number;
  /** Stable, order-independent identity of the frame. Opaque to the core. */
  readonly key?: string | undefined;
  /** Presentation time in seconds, for temporal axes (cine, video). */
  readonly time?: number | undefined;
}

/**
 * Extension field placing an annotation on one frame.
 *
 * Composes with the other extension fields by intersection, like
 * `ImageIdFields`. An annotation of a multi-frame source *without* `frame` is
 * series-level: it applies to (and is shown on) every frame. That is also what
 * every annotation written before frames existed means, so documents stay
 * valid without migration.
 */
export interface FrameFields {
  readonly frame: FrameRef;
}

/** An annotation that may carry a frame. */
export type MaybeFramed = Annotation<Partial<FrameFields>>;

/** Narrow an annotation to one that is placed on a frame. */
export function hasFrame<A extends MaybeFramed>(annotation: A): annotation is A & FrameFields {
  return annotation.frame !== undefined;
}

/**
 * Whether the annotation is shown on frame `index`: placed on it, or
 * series-level (no frame at all).
 */
export function isOnFrame(annotation: MaybeFramed, index: number): boolean {
  return annotation.frame === undefined || annotation.frame.index === index;
}

/** Whether two frame references name the same frame (by key when both have one). */
export function sameFrame(a: FrameRef, b: FrameRef): boolean {
  if (a.key !== undefined && b.key !== undefined) return a.key === b.key;
  return a.index === b.index;
}
