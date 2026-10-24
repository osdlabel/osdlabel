import type { FrameAxis, FrameIndex } from './frame-axis.js';
import { positionOf, reconcileFrame } from './frame-axis.js';

/**
 * A frame as stored in a document, so it can be found again on an axis that
 * another demuxer (or another build of the same one) produced.
 *
 * `index` is the frame's position in presentation order on the axis the
 * writer had. `timeUs`, on a time axis, is the frame's **start presentation
 * timestamp in integer microseconds**: never a seek target, never a midpoint,
 * never `HTMLVideoElement.currentTime` read while paused. Those are times
 * *inside* the frame; store the start of the frame they show instead (on a
 * player, `requestVideoFrameCallback`'s `mediaTime`, or the demuxed table).
 *
 * On load, {@link resolveFrameRef} prefers `timeUs`, because indices shift
 * when the reader's axis does not start where the writer's did (an edit list,
 * a trimmed export); the index is the fallback.
 */
export interface FrameRef {
  readonly index: FrameIndex;
  readonly timeUs?: number;
}

/** The ref to store for frame `i`: its index and, on a time axis, its start in integer µs. */
export function frameRefOf(axis: FrameAxis, i: FrameIndex): FrameRef {
  const p = positionOf(axis, i);
  return axis.kind === 'time' ? { index: i, timeUs: Math.round(p) } : { index: i };
}

/**
 * The frame a stored ref points at on `axis`: {@link reconcileFrame} of its
 * `timeUs` when it has one, else its index clamped to the axis.
 */
export function resolveFrameRef(axis: FrameAxis, ref: FrameRef): FrameIndex {
  if (ref.timeUs !== undefined && axis.kind === 'time') return reconcileFrame(axis, ref.timeUs);
  return Math.min(Math.max(0, Math.round(ref.index)), axis.frameCount - 1);
}
