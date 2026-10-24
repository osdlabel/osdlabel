/**
 * A frame axis: the ordered, discrete set of frames a temporal medium has.
 *
 * Video, ultrasound cine and CT/MR stacks share this shape. What differs is
 * only what a frame's *position* means: a presentation time for video and
 * cine (microseconds), a slice location for a stack (millimetres along the
 * stack normal). Annotation tracks are keyed by the integer {@link FrameIndex}
 * and never by the position, so the same track model serves all three.
 *
 * Frame `i` is the i-th frame in *presentation* order. For video with
 * B-frames that is not decode order; the demuxer builds the axis from the
 * presentation timestamps after sorting.
 */
export type FrameIndex = number;

/** What a frame's position is measured in. */
export type FrameAxisUnit = 'microseconds' | 'millimetres';

export interface FrameAxis {
  /** `'time'` for video and cine, `'space'` for stacks. */
  readonly kind: 'time' | 'space';
  readonly unit: FrameAxisUnit;
  readonly frameCount: number;
  /**
   * Position of each frame, strictly increasing, `frameCount` entries. For a
   * time axis, entry `i` is the presentation timestamp of frame `i`.
   */
  readonly positions: readonly number[];
  /**
   * Length of the last frame (its duration for a time axis). Every other
   * frame's extent is the gap to the next position.
   */
  readonly lastFrameExtent: number;
}

function assertIncreasing(positions: readonly number[]): void {
  for (let i = 1; i < positions.length; i++) {
    if (!(positions[i]! > positions[i - 1]!)) {
      throw new Error(`frame axis positions must strictly increase (index ${i})`);
    }
  }
}

/**
 * A constant-rate time axis. `fpsNum / fpsDen` is the rate as a rational, so
 * 29.97 fps is `30000 / 1001` and every timestamp is computed from the frame
 * index, not accumulated (accumulating 1/29.97 drifts).
 */
export function createConstantRateAxis(
  frameCount: number,
  fpsNum: number,
  fpsDen = 1,
  startUs = 0,
): FrameAxis {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error('frameCount must be a positive integer');
  }
  const positions: number[] = new Array<number>(frameCount);
  for (let i = 0; i < frameCount; i++) positions[i] = startUs + (i * 1e6 * fpsDen) / fpsNum;
  return {
    kind: 'time',
    unit: 'microseconds',
    frameCount,
    positions,
    lastFrameExtent: (1e6 * fpsDen) / fpsNum,
  };
}

/**
 * A time axis from explicit presentation timestamps: a variable-frame-rate
 * video's sample table, or a DICOM cine's Frame Time Vector (0018,1065)
 * accumulated into timestamps.
 */
export function createTimestampAxis(
  timestampsUs: readonly number[],
  lastDurationUs: number,
): FrameAxis {
  if (timestampsUs.length === 0) throw new Error('a frame axis needs at least one frame');
  assertIncreasing(timestampsUs);
  return {
    kind: 'time',
    unit: 'microseconds',
    frameCount: timestampsUs.length,
    positions: [...timestampsUs],
    lastFrameExtent: lastDurationUs,
  };
}

/** A spatial axis for a CT/MR stack, from each slice's position along the normal. */
export function createSliceAxis(
  slicePositionsMm: readonly number[],
  sliceThicknessMm: number,
): FrameAxis {
  if (slicePositionsMm.length === 0) throw new Error('a frame axis needs at least one frame');
  assertIncreasing(slicePositionsMm);
  return {
    kind: 'space',
    unit: 'millimetres',
    frameCount: slicePositionsMm.length,
    positions: [...slicePositionsMm],
    lastFrameExtent: sliceThicknessMm,
  };
}

/**
 * The frame on screen at `position`: the last frame whose position is at or
 * before it (a frame is shown from its timestamp until the next one's).
 * Clamped to `[0, frameCount - 1]`. Binary search, O(log n).
 */
export function frameAt(axis: FrameAxis, position: number): FrameIndex {
  const p = axis.positions;
  if (position <= p[0]!) return 0;
  let lo = 0;
  let hi = p.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid]! <= position) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The frame whose position is nearest `position` (ties go to the earlier
 * frame). Kept as the named alternative to {@link reconcileFrame}; do not use
 * it to resolve stored times. It is right only for writers that store a
 * frame's *start* time plus noise. A writer that stores a time inside the
 * frame (a paused `currentTime`, a seek target at the frame's midpoint) lands
 * past the midpoint half the time and is re-attached to the *next* frame:
 * `apps/poc-video` axis study, 922 of 3,600 frames wrong for table-midpoint
 * times and about 1,750 for times uniform in the frame's span, where
 * {@link reconcileFrame} gets 0 and about 3%.
 */
export function nearestFrame(axis: FrameAxis, position: number): FrameIndex {
  const p = axis.positions;
  const i = frameAt(axis, position);
  const next = p[i + 1];
  return next !== undefined && next - position < position - p[i]! ? i + 1 : i;
}

/** Cap of {@link reconcileFrame}'s tolerance on a time axis: 1 ms, in microseconds. */
export const RECONCILE_TOLERANCE_CAP_US = 1000;

/**
 * Resolve a *stored* frame time to a frame: the frame on screen at
 * `position + tolerance`, where the tolerance is a quarter of the frame
 * containing `position`, capped at {@link RECONCILE_TOLERANCE_CAP_US} on a
 * time axis (uncapped on a slice axis unless `cap` says otherwise).
 *
 * The contract it serves: a stored time is the frame's START presentation
 * timestamp (`FrameRef.timeUs`, integer microseconds). The tolerance absorbs
 * what happens to a start time on its way through other writers and readers
 * (millisecond rounding or truncation, a float seconds round trip, nominal
 * `i / fps`, one demuxer truncating to microseconds where another rounds),
 * all of which land a hair *before* the start and make plain
 * {@link frameAt} slip back one frame. Unlike {@link nearestFrame} it still
 * answers "the frame on screen" for a time inside a frame, except within the
 * tolerance of the next frame's start (1 ms of a 33 ms frame, about 3%).
 */
export function reconcileFrame(
  axis: FrameAxis,
  position: number,
  cap: number = axis.unit === 'microseconds'
    ? RECONCILE_TOLERANCE_CAP_US
    : Number.POSITIVE_INFINITY,
): FrameIndex {
  const j = frameAt(axis, position);
  return frameAt(axis, position + Math.min(cap, extentOf(axis, j) / 4));
}

/** Start position of frame `i`. */
export function positionOf(axis: FrameAxis, i: FrameIndex): number {
  const v = axis.positions[i];
  if (v === undefined) throw new RangeError(`frame ${i} is outside [0, ${axis.frameCount - 1}]`);
  return v;
}

/** Extent of frame `i` (its duration on a time axis). */
export function extentOf(axis: FrameAxis, i: FrameIndex): number {
  const start = positionOf(axis, i);
  const next = axis.positions[i + 1];
  return next === undefined ? axis.lastFrameExtent : next - start;
}

/**
 * The position halfway through frame `i`. Seeking an `HTMLVideoElement` here
 * rather than to the frame's start avoids landing on the previous frame
 * through float rounding of `currentTime`.
 */
export function midpointOf(axis: FrameAxis, i: FrameIndex): number {
  return positionOf(axis, i) + extentOf(axis, i) / 2;
}
