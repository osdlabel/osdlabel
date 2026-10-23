import type { FrameRef } from './frame-ref.js';

/**
 * Whether the frame axis is spatial (slices through a volume) or temporal
 * (a cine loop, a video). It changes defaults, not the data model: wheel
 * steps slices on a spatial axis; a temporal axis is played, and reconciled
 * by time.
 */
export type FrameAxisKind = 'spatial' | 'temporal';

/**
 * The frame axis of a multi-frame image source.
 *
 * Every per-frame array, when present, has exactly `count` entries in
 * presentation order. All of them are optional: a procedurally generated
 * stack has only a count, a DICOM series has keys and positions, a cine loop
 * has times.
 */
export interface FrameAxis {
  readonly kind: FrameAxisKind;
  /** Number of frames. At least 1. */
  readonly count: number;
  /** Stable identity per frame; see {@link FrameRef.key}. */
  readonly keys?: readonly string[] | undefined;
  /** Presentation time per frame, in seconds, ascending. */
  readonly times?: readonly number[] | undefined;
  /** Nominal playback rate in frames per second (temporal axes). */
  readonly frameRate?: number | undefined;
  /**
   * Position of each slice along the stack normal, in the unit of the
   * source's pixel spacing (spatial axes). Lets a host show a slice location
   * or step by distance instead of by index.
   */
  readonly positions?: readonly number[] | undefined;
}

/** Clamp `index` onto the axis. Non-finite input lands on frame 0. */
export function clampFrameIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count < 1) return 0;
  return Math.max(0, Math.min(Math.trunc(index), count - 1));
}

/**
 * Step `delta` frames from `index`. A spatial stack stops at its ends (a
 * radiologist scrolling past the last slice expects to stay there); a loop
 * wraps.
 */
export function stepFrameIndex(index: number, delta: number, count: number, wrap: boolean): number {
  if (count < 1) return 0;
  const next = Math.trunc(index) + Math.trunc(delta);
  if (!wrap) return clampFrameIndex(next, count);
  return ((next % count) + count) % count;
}

/**
 * The frame being presented at time `t` (seconds): the last frame whose time
 * is at or before `t`. Uses `times` when present, else `frameRate`. Binary
 * search, so it is O(log n) per call — cheap enough to run every display
 * frame of a 60 fps cine.
 */
export function frameIndexAtTime(axis: FrameAxis, t: number): number {
  const times = axis.times;
  if (times && times.length > 0) {
    if (!(t >= (times[0] ?? 0))) return 0;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((times[mid] ?? Infinity) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  const rate = axis.frameRate ?? 0;
  if (rate <= 0) return 0;
  return clampFrameIndex(Math.floor(t * rate + 1e-9), axis.count);
}

/** The frame reference an annotation drawn on frame `index` should carry. */
export function frameRefAt(axis: FrameAxis, index: number): FrameRef {
  const i = clampFrameIndex(index, axis.count);
  const key = axis.keys?.[i];
  const time = axis.times?.[i] ?? (axis.frameRate ? i / axis.frameRate : undefined);
  return {
    index: i,
    ...(key !== undefined ? { key } : {}),
    ...(time !== undefined && axis.kind === 'temporal' ? { time } : {}),
  };
}
