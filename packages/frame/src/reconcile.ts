import type { FrameAxis } from './frame-axis.js';
import { frameIndexAtTime } from './frame-axis.js';
import type { MaybeFramed } from './frame-ref.js';

/** Outcome of {@link reconcileFrameRefs}. */
export interface ReconcileResult<A extends MaybeFramed> {
  /** Every annotation, with `frame.index` rewritten where the axis says so. Unchanged ones keep identity. */
  readonly annotations: readonly A[];
  /** Annotations whose `key` the axis does not contain. Their index was left as stored. */
  readonly orphaned: readonly A[];
  /** How many indices were rewritten. */
  readonly moved: number;
}

/**
 * Re-derive each annotation's `frame.index` from the axis it is about to be
 * shown on.
 *
 * Needed whenever the axis is built by different code than the one the
 * annotations were drawn against: a DICOM series sorted by Instance Number in
 * one loader and by Image Position (Patient) in another puts the same slice at
 * different indices, and a video re-decoded at another rate does the same to
 * frames. `key` wins when both sides have keys; otherwise `time` is mapped
 * through the axis; otherwise the stored index stands.
 *
 * Identity-preserving: annotations whose index is already right are returned
 * as the same objects, so a store diff touches only those that moved.
 */
export function reconcileFrameRefs<A extends MaybeFramed>(
  annotations: readonly A[],
  axis: FrameAxis,
): ReconcileResult<A> {
  const keyIndex = new Map<string, number>();
  axis.keys?.forEach((key, i) => keyIndex.set(key, i));
  const out: A[] = [];
  const orphaned: A[] = [];
  let moved = 0;
  for (const a of annotations) {
    const frame = a.frame;
    if (frame === undefined) {
      out.push(a);
      continue;
    }
    let target: number | undefined;
    if (frame.key !== undefined && keyIndex.size > 0) {
      target = keyIndex.get(frame.key);
      if (target === undefined) {
        orphaned.push(a);
        out.push(a);
        continue;
      }
    } else if (frame.time !== undefined && axis.kind === 'temporal') {
      target = frameIndexAtTime(axis, frame.time);
    }
    if (target === undefined || target === frame.index) {
      out.push(a);
      continue;
    }
    moved++;
    out.push({ ...a, frame: { ...frame, index: target } });
  }
  return { annotations: out, orphaned, moved };
}
